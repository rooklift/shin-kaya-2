"use strict";

const fs = require("fs/promises");
const slashpath = require("./slashpath");
const { ends_with_any } = require("./utils");

const skippable_ends = [".db", ".db-shm", ".db-wal", "journal"];

async function list_all_files(archivepath, relpath) {
	let ret = [];
	let read = await fs.readdir(slashpath.join(archivepath, relpath));
	for (let o of read) {
		let o_lower = o.toLowerCase();
		if (ends_with_any(o_lower, skippable_ends)) {
			continue;
		}
		let new_relpath = slashpath.join(relpath, o);
		if (o_lower.endsWith(".sgf")) {												// We think this is a file...
			ret.push(new_relpath);
		} else {																	// We think this is a directory... but maybe not.
			try {
				let recurse = await list_all_files(archivepath, new_relpath);
				ret = ret.concat(recurse);
			} catch (err) {
				// skip
			}
		}
	}
	return ret;
}

module.exports = {list_all_files};
