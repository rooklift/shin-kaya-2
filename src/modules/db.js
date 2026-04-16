"use strict";

const fs = require("fs");

const bridge = require("./db_bridge");
const slashpath = require("./slashpath");

const { list_all_files } = require("./walk_promises");
const { create_record_from_path } = require("./records");

const DELETION_BATCH_SIZE = 5;
const ADDITION_BATCH_SIZE = 47;

let current_db = null;
let work_in_progress = false;
let abort_flag = false;										// FIXME - check what uses this.

exports.current = function() {
	return current_db;
};

exports.wip = function() {
	return work_in_progress;
};

exports.connect = function() {

	if (work_in_progress) {
		throw new Error("connect() called while work in progress");
	}

	if (current_db) {
		current_db("quit");
		current_db = null;
	}

	if (typeof config.sgfdir !== "string" || !fs.existsSync(config.sgfdir)) {
		config.sgfdir = null;
		return;
	}

	current_db = bridge.new_db();
	let filepath = slashpath.join(config.sgfdir, ".shin-kaya.db");

	current_db(`expect ["relpath", "dyer", "movecount", "SZ", "HA", "PB", "PW", "BR", "WR", "RE", "DT", "EV", "RO"]`);
	current_db(`load ${filepath}`);

};

exports.update = function() {

	if (!current_db) {
		return Promise.reject(new Error("update(): No database."));
	}

	if (work_in_progress) {
		return Promise.reject(new Error("update(): Work is in progress."));
	}

	work_in_progress = true;

	return Promise.all
	(
		[
			list_all_files(config.sgfdir, ""),
			current_db("select {}"),
		]
	)

	.then(foo => {

		let [files, records] = foo;

		let db_set = Object.create(null);
		let file_set = Object.create(null);

		for (let f of files) {
			file_set[f] = true;
		}

		for (let o of records) {
			db_set[o.relpath] = true;
		}

		// Make the diffs...

		let missing_files = [];
		let new_files = [];

		for (let key of Object.keys(db_set)) {
			if (!file_set[key]) {
				missing_files.push(key);
			}
		}
		for (let key of Object.keys(file_set)) {
			if (!db_set[key]) {
				new_files.push(key);
			}
		}

		let all_promises = [];

		for (let relpath of missing_files) {
			all_promises.push(current_db(`delete {"relpath": "${relpath}"}`));
		}

		for (let relpath of new_files) {
			let record = create_record_from_path(config.sgfdir, relpath);
			all_promises.push(current_db(`add ${JSON.stringify(record)}`));
		}

		return Promise.all(all_promises);
	});

};
