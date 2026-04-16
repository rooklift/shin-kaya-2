"use strict";

const child_process = require("child_process");
const readline = require("readline");

exports.new_db = function() {

	let exe = child_process.spawn("./simpledb.exe");

	let shutdown = false;
	let queue = [];				// {cmd, resolve, reject} objects waiting to be sent
	let in_flight = null;		// {cmd, resolve, reject} of the currently active command
	let select_records = [];
	let select_remaining = null;

	let scanner = readline.createInterface({
		input: exe.stdout,
		output: undefined,
		terminal: false
	});

	function send_next() {
		if (in_flight || queue.length === 0) {
			return;
		}
		in_flight = queue.shift();
		exe.stdin.write(in_flight.cmd + "\n");
	}

	function finish(result) {
		in_flight.resolve(result);
		in_flight = null;
		send_next();
	}

	function fail(msg) {
		shutdown = true;
		in_flight.reject(new Error(msg));
		in_flight = null;
		for (let item of queue) {
			item.reject(new Error("database shutdown"));
		}
		queue = [];
	}

	scanner.on("line", (line) => {

		if (shutdown || !in_flight) {
			return;
		}

		let o;
		try {
			o = JSON.parse(line);
		} catch (e) {
			fail(`bad JSON from db: ${line}`);
			return;
		}

		// Handle select: first line has count, then that many record lines follow

		if (in_flight.cmd.startsWith("select ")) {

			if (select_remaining === null) {
				// This is the status line
				if (o.error) {
					fail(o.error);
					return;
				}
				if (o.count === undefined) {
					fail(`first line of select didn't specify count: ${line}`);
					return;
				}
				select_records = [];
				select_remaining = o.count;
				if (select_remaining === 0) {
					select_remaining = null;
					finish([]);
				}
				return;
			}

			select_records.push(o);
			select_remaining--;

			if (select_remaining <= 0) {
				let results = select_records;
				select_records = [];
				select_remaining = null;
				finish(results);
			}
			return;
		}

		// All other commands: single-line response

		if (o.error) {
			fail(o.error);
			return;
		}

		finish(o);
	});

	// ------------------------------------------------------------------------
	// The actual thing the creator of the DB gets...

	return function(cmd) {
		if (shutdown) {
			return Promise.reject(new Error("database has shutdown"));
		}
		return new Promise((resolve, reject) => {
			queue.push({cmd, resolve, reject});
			send_next();
		});
	};
};
