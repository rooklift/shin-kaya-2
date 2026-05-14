"use strict";

const fs = require("fs");

const gogod_name_fixes = require("./gogod_name_fixes");
const load_sgf = require("./load_sgf");
const natural_compare = require("./natural_compare");
const slashpath = require("./slashpath");
const { safe_html } = require("./utils");

function create_record(root, relpath) {					// root is an SGF node

	let ret = {
		relpath:   relpath,
		dyer:      root.dyer(),
		movecount: move_count(root).toString(),
		SZ:        "19",								// Maybe changed below.
		HA:        "0",									// Maybe changed below.
		PB:        root.get("PB"),
		PW:        root.get("PW"),
		BR:        root.get("BR").replace("级", "k").replace("段", "d"),
		WR:        root.get("WR").replace("级", "k").replace("段", "d"),
		RE:        canonicalresult(root.get("RE")),
		DT:        canonicaldate(root.get("DT")),
		EV:        root.get("EV"),
		RO:        root.get("RO"),
	};

	for (let key of ["SZ", "HA"]) {
		let i = parseInt(root.get(key), 10);
		if (!Number.isNaN(i)) {
			ret[key] = i.toString();
		}
	}

	// Apply GoGoD name fixes...

	if (config.apply_gogod_fixes) {
		if (gogod_name_fixes[ret.PB]) ret.PB = gogod_name_fixes[ret.PB];
		if (gogod_name_fixes[ret.PW]) ret.PW = gogod_name_fixes[ret.PW];
	}

	return ret;
}

function move_count(root) {
	let node = root;
	let count = 0;
	while (true) {
		if (node.has_key("B") || node.has_key("W")) {
			count++;
		}
		if (node.children.length > 0) {
			node = node.children[0];
		} else {
			return count;
		}
	}
}

function create_record_from_path(archivepath, relpath) {				// Can throw

	let fullpath = slashpath.join(archivepath, relpath);

	if (!fs.existsSync(fullpath)) {
		throw new Error("No such file");
	}

	let buf = fs.readFileSync(fullpath);								// Can throw (theoretically and maybe actually)
	let root = load_sgf(buf);											// Can throw

	return create_record(root, relpath);
}

function canonicaldate(DT) {

	let m;

	m = DT.match(/\d\d\d\d-\d\d-\d\d/g);
	if (m && m.length > 0) return m[0];

	m = DT.match(/\d\d\d\d-\d\d/g);
	if (m && m.length > 0) return m[0];

	m = DT.match(/\d\d\d\d/g);
	if (m && m.length > 0) return m[0];

	m = DT.match(/\d\d\d/g);
	if (m && m.length > 0) return "0" + m[0];							// Always stored years as 4 digits

	return "";
}

function canonicalresult(RE) {

	RE = RE.trim().toUpperCase();

	if (RE.startsWith("B+R")) return "B+R";
	if (RE.startsWith("W+R")) return "W+R";
	if (RE.startsWith("B+T")) return "B+T";
	if (RE.startsWith("W+T")) return "W+T";
	if (RE.startsWith("B+F")) return "B+F";
	if (RE.startsWith("W+F")) return "W+F";
	if (RE.startsWith("VOID")) return "Void";
	if (RE.startsWith("JIGO")) return "Draw";
	if (RE.startsWith("DRAW")) return "Draw";
	if (RE === "0") return "Draw";

	if (RE.startsWith("B+") || RE.startsWith("W+")) {

		let slice_index = 2;

		while ("0123456789.".includes(RE[slice_index])) {
			slice_index++;
		}

		return RE.slice(0, slice_index);
	}

	return "?";
}

function sort_records(records) {
	records.sort((a, b) => {
		if (a.DT < b.DT) return -1;
		if (a.DT > b.DT) return 1;
		let evc = natural_compare(a.EV, b.EV);
		if (evc !== 0) {
			return evc;
		}
		let rc = natural_compare(a.RO, b.RO);
		if (rc !== 0) {
			return rc;
		}
		if (a.relpath < b.relpath) return -1;
		if (a.relpath > b.relpath) return 1;
		// if (a.PB < b.PB) return -1;					// Pointless now since relpath is sure to be different.
		// if (a.PB > b.PB) return 1;
		return 0;
	});
}

function deduplicate_records(records) {

	records.sort((a, b) => {
		if (a.dyer < b.dyer) return -1;
		if (a.dyer > b.dyer) return 1;
		if (a.DT < b.DT) return -1;
		if (a.DT > b.DT) return 1;
		if (a.movecount < b.movecount) return -1;		// Note that (like everything else) movecount is stored
		if (a.movecount > b.movecount) return 1;		// as a string, but this is OK for deduplication purposes.
		return 0;
	});

	for (let n = records.length - 1; n > 0; n--) {
		if (records[n].dyer === records[n - 1].dyer && records[n].DT === records[n - 1].DT && records[n].movecount === records[n - 1].movecount) {
			records.splice(n, 1);						// In place
		}
	}
}

function span_string(record, element_id) {

	let result_direction = "?";
	if (record.RE.startsWith("B+")) result_direction = ">";
	if (record.RE.startsWith("W+")) result_direction = "<";

	let ha_string = (record.HA >= 2) ? `H${record.HA}` : "";
	let black_string = `${record.PB} ${record.BR}`.trim();
	let white_string = `${record.PW} ${record.WR}`.trim();

	let ev_ro_string = record.EV;
	if (record.RO) {
		ev_ro_string += ` (${record.RO})`;
	}

	return `<div id="${element_id}" class="game">` +
		cell_string("game_date", record.DT) +
		cell_string("game_result", record.RE) +
		cell_string("game_movecount", record.movecount) +
		cell_string("game_handicap", ha_string) +
		cell_string("game_black", black_string) +
		cell_string("game_direction", result_direction) +
		cell_string("game_white", white_string) +
		cell_string("game_event", ev_ro_string) +
		"</div>";
}

function cell_string(class_name, value) {
	let html_value = safe_html(value);
	return `<span class="${class_name}" title="${html_value}">${html_value}</span>`;
}



module.exports = {create_record_from_path, sort_records, deduplicate_records, span_string};
