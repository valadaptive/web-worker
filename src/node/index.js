/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { URL, fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import VM from 'vm';
import threads from 'worker_threads';
import { setMaxListeners } from 'events';

const WORKER = Symbol.for('worker');

function legacyEventHandlers(...handlers) {
	const x = class extends EventTarget {
		constructor(...args) {
			super(...args);
			setMaxListeners(Infinity, this);
		}
	};
	for (const handlerName of handlers) {
		let handlerValue = null;
		Object.defineProperty(x.prototype, 'on' + handlerName, {
			get() {return handlerValue;},
			set(handler) {
				if (handlerValue) {
					this.removeEventListener(handlerName, handlerValue);
				}
				handlerValue = handler;
				if (handlerValue) this.addEventListener(handlerName, handlerValue);
			}
		});
	}
	return x;
}

// this module is used self-referentially on both sides of the
// thread boundary, but behaves differently in each context.
export default typeof Worker === 'function' ? Worker : threads.isMainThread ? mainThread() : workerThread();

const baseUrl = pathToFileURL(process.cwd() + '/');

function mainThread() {

	/**
	 * A web-compatible Worker implementation atop Node's worker_threads.
	 *  - uses DOM-style events (Event.data, Event.type, etc)
	 *  - supports event handler properties (worker.onmessage)
	 *  - Worker() constructor accepts a module URL
	 *  - accepts the {type:'module'} option
	 *  - emulates WorkerGlobalScope within the worker
	 * @param {string} url  The URL or module specifier to load
	 * @param {object} [options]  Worker construction options
	 * @param {string} [options.name]  Available as `self.name` within the Worker
	 * @param {string} [options.type="classic"]  Pass "module" to create a Module Worker.
	 */
	class Worker extends legacyEventHandlers('message', 'error', 'close') {
		constructor(url, options) {
			super();
			this.refCount = 0;
			const { name, type } = options || {};
			url += '';
			let mod;
			if (/^data:/.test(url)) {
				mod = url;
			}
			else {
				mod = fileURLToPath(new URL(url, baseUrl));
			}
			const worker = new threads.Worker(
				fileURLToPath(import.meta.url),
				{ workerData: { mod, name, type } }
			);
			Object.defineProperty(this, WORKER, {
				value: worker
			});
			worker.on('message', data => {
				const event = new Event('message');
				event.data = data;
				this.dispatchEvent(event);
			});
			worker.on('error', error => {
				const event = new Event('error');
				event.data = error;
				this.dispatchEvent(event);
			});
			worker.on('exit', () => {
				this.dispatchEvent(new Event('close'));
			});
			worker.unref();
		}
		postMessage(data, transferList) {
			this[WORKER].postMessage(data, transferList);
		}
		terminate() {
			this[WORKER].terminate();
		}

		addEventListener(...args) {
			if (this.refCount === 0) this[WORKER].ref();
			this.refCount++;
			super.addEventListener(...args);
		}
		removeEventListener(...args) {
			this.refCount--;
			if (this.refCount === 0) this[WORKER].unref();
			super.addEventListener(...args);
		}
	}
	return Worker;
}

function workerThread() {
	// loaded in a real Web Worker (eg: on Electron)
	if (typeof global.WorkerGlobalScope === 'function') {
		return;
	}
	let { mod, name, type } = threads.workerData;
	if (!mod) return mainThread();

	// turn global into a mock WorkerGlobalScope
	const self = global.self = global;

	// enqueue messages to dispatch after modules are loaded
	let q = [];
	function flush() {
		const buffered = q;
		q = null;
		buffered.forEach(event => { self.dispatchEvent(event); });
	}
	threads.parentPort.on('message', data => {
		const event = new Event('message');
		event.data = data;
		if (q == null) self.dispatchEvent(event);
		else q.push(event);
	});
	threads.parentPort.on('error', err => {
		err.type = 'Error';
		const event = new Event('error');
		event.data = err;
		self.dispatchEvent(event);
	});

	// Don't count the parentPort event listener for the purpose of keeping the event loop alive
	threads.parentPort.unref();
	let refCount = 0;

	class WorkerGlobalScope extends legacyEventHandlers('message',  'close') {
		postMessage(data, transferList) {
			threads.parentPort.postMessage(data, transferList);
		}
		// Emulates https://developer.mozilla.org/en-US/docs/Web/API/DedicatedWorkerGlobalScope/close
		close() {
			process.exit();
		}
		importScripts(...args) {
			for (const url of args) {
				let code;
				if (/^data:/.test(url)) {
					code = parseDataUrl(url).data;
				}
				else {
					code = fs.readFileSync(
						new URL(path.posix.normalize(url), pathToFileURL(mod)),
						'utf-8'
					);
				}
				VM.runInThisContext(code, { filename: url });
			}
		}
		addEventListener(...args) {
			if (refCount === 0) threads.parentPort.ref();
			refCount++;
			super.addEventListener(...args);
		}
		removeEventListener(...args) {
			refCount--;
			if (refCount === 0) threads.parentPort.unref();
			super.addEventListener(...args);
		}
	}
	let proto = Object.getPrototypeOf(global);
	delete proto.constructor;
	Object.defineProperties(WorkerGlobalScope.prototype, proto);
	proto = Object.setPrototypeOf(global, new WorkerGlobalScope());
	['postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent'].forEach(fn => {
		proto[fn] = proto[fn].bind(global);
	});
	global.name = name;
	global.WorkerGlobalScope = WorkerGlobalScope;

	const isDataUrl = /^data:/.test(mod);
	if (type === 'module') {
		import(isDataUrl ? mod : pathToFileURL(mod))
			.catch(err => {
				if (isDataUrl && err.message === 'Not supported') {
					console.warn('Worker(): Importing data: URLs requires Node 12.10+. Falling back to classic worker.');
					return evaluateDataUrl(mod, name);
				}
				console.error(err);
			})
			.then(flush);
	}
	else {
		try {
			if (/^data:/.test(mod)) {
				evaluateDataUrl(mod, name);
			}
			else {
				global.importScripts(mod);
			}
		}
		catch (err) {
			console.error(err);
		}
		Promise.resolve().then(flush);
	}
}

function evaluateDataUrl(url, name) {
	const { data } = parseDataUrl(url);
	return VM.runInThisContext(data, {
		filename: 'worker.<'+(name || 'data:')+'>'
	});
}

function parseDataUrl(url) {
	let [m, type, encoding, data] = url.match(/^data: *([^;,]*)(?: *; *([^,]*))? *,(.*)$/) || [];
	if (!m) throw Error('Invalid Data URL.');
	data = decodeURIComponent(data);
	if (encoding) switch (encoding.toLowerCase()) {
		case 'base64':
			data = Buffer.from(data, 'base64').toString();
			break;
		default:
			throw Error('Unknown Data URL encoding "' + encoding + '"');
	}
	return { type, data };
}
