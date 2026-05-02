"use strict";

const { ipcRenderer, shell } = require("electron");
const fs = require("fs/promises");

const config_io = require("./config_io");
const db = require("./db_new");
const new_node = require("./node");
const set_thumbnail = require("./thumbnail");
const load_sgf = require("./load_sgf");
const slashpath = require("./slashpath");
const { new_board } = require("./board");
const { sort_records, deduplicate_records, span_string } = require("./records");

function init() {

	let hub_prototype = {};
	Object.assign(hub_prototype, hub_main_props);
	Object.assign(hub_prototype, require("./hub_settings"));

	let ret = Object.create(hub_prototype);
	ret.lookups = [];
	ret.records = [];
	ret.index = null;
	ret.row_height = 0;
	ret.preview_request_id = 0;
	ret.preview_node = new_node();

	set_thumbnail(ret.preview_node);

	return ret;
}

let hub_main_props = {

	status_text: function(msg) {
		document.getElementById("status").textContent = msg;
	},

	status_html: function(msg) {
		document.getElementById("status").innerHTML = msg;
	},

	quit: function() {
		config_io.save();					// As long as we use the sync save, this will complete before we
		ipcRenderer.send("terminate");		// send "terminate". Not sure about results if that wasn't so.
	},

	display_no_connection: function() {
		this.status_text(`No database open`);
	},

	connect_db: function() {
		if (db.wip()) {
			alert("Unable. Work is in progress.");
			return;
		}
		db.connect().then(() => this.display_row_count()).catch(err => {
			console.log(err);
			this.status_text(err.toString());
		});
	},

	update_db: function() {
		if (this.unable()) {
			return;
		}
		this.status_text(`Updating, this may take some time...`);
		db.update().then((o) => {
			if (o.new_records.length > 0) {
				this.handle_records(o.new_records);
			}
			this.status_text(`Update completed - deletions: ${o.deletions}, additions: ${o.additions}`);
		}).catch(err => {
			console.log(err);
			this.status_text(err.toString());
		});
	},

	stop_update: function() {
		db.stop_update();
	},

	unable: function() {
		if (db.wip()) {
			alert("Unable. Work is in progress.");
			return true;
		}
		if (!db.connected()) {
			this.display_no_connection();
			return true;
		}
		return false;
	},

	reset_db: function() {
		if (!this.unable()) {
			db.clear().then(() => db.save()).then(() => {
				this.display_row_count();
			}).catch(err => {
				console.log(err);
				db.connect().then(() => {
					this.status_text(`Reset failed: ${err.toString()}. Reloaded database from disk.`);
				}).catch(reload_err => {
					console.log(reload_err);
					this.status_text(`Reset failed: ${err.toString()}. Reload also failed: ${reload_err.toString()}`);
				});
			});
		}
	},

	display_row_count: function() {
		if (!this.unable()) {
			this.status_text(`Database has ${db.count()} entries - ${config.sgfdir}`);
		}
	},

	handle_records: function(records) {

		let truncated_from = null;

		if (records.length > 2000) {
			truncated_from = records.length;
			records = records.slice(0, 2000);
		}

		let dedup_count = 0;

		if (config.deduplicate) {
			let length_before = records.length;
			deduplicate_records(records);
			dedup_count = length_before - records.length;
		}

		sort_records(records);		// After the above deduplication, which also has an in-place sort during the process.

		this.records = records;
		this.lookups = records.map(r => r.relpath);

		let count_string = `<span class="bold">${records.length}</span> ${records.length === 1 ? "game" : "games"} shown`;

		if (dedup_count > 0) {
			count_string += `;  deduplicated ${dedup_count} ${dedup_count === 1 ? "game" : "games"}`;
		}

		if (truncated_from) {
			count_string += `;  too many results (${truncated_from})`;
		}

		this.status_html(count_string);

		this.ensure_row_height();

		let gamesbox = document.getElementById("gamesbox");
		gamesbox.scrollTop = 0;
		let total_height = records.length * this.row_height;
		gamesbox.innerHTML = `<div id="games_inner" style="height:${total_height}px"></div>`;

		this.index = null;
		this.set_preview_from_path(null);
		document.getElementById("path").textContent = " ";

		this.render_visible();
	},

	ensure_row_height: function() {
		if (this.row_height > 0) {
			return;
		}
		let gamesbox = document.getElementById("gamesbox");
		let test = document.createElement("div");
		test.className = "game";
		test.style.visibility = "hidden";
		test.style.position = "static";
		test.innerHTML = `<span class="game_date">2024-01-01</span><span class="game_result">B+R</span><span class="game_movecount">100</span><span class="game_handicap">H9</span><span class="game_black">M</span><span class="game_direction">?</span><span class="game_white">M</span><span class="game_event">M</span>`;
		gamesbox.appendChild(test);
		let h = test.getBoundingClientRect().height;
		test.remove();
		this.row_height = h > 0 ? h : 22;

		let style_el = document.createElement("style");
		style_el.textContent = `.game { height: ${this.row_height}px; line-height: ${this.row_height}px; }`;
		document.head.appendChild(style_el);
	},

	render_visible: function() {
		let inner = document.getElementById("games_inner");
		if (!inner) {
			return;
		}
		if (this.records.length === 0) {
			inner.innerHTML = "";
			return;
		}

		let gamesbox = document.getElementById("gamesbox");
		let row_h = this.row_height;
		let scroll_top = gamesbox.scrollTop;
		let viewport = gamesbox.clientHeight;
		let buffer = 10;

		let first = Math.max(0, Math.floor(scroll_top / row_h) - buffer);
		let last = Math.min(this.records.length - 1, Math.ceil((scroll_top + viewport) / row_h) + buffer);

		let parts = [];
		for (let i = first; i <= last; i++) {
			parts.push(span_string(this.records[i], `gamesbox_entry_${i}`, i * row_h));
		}
		inner.innerHTML = parts.join("");

		if (Number.isInteger(this.index) && this.index >= first && this.index <= last) {
			let el = document.getElementById(`gamesbox_entry_${this.index}`);
			if (el) {
				el.classList.add("highlightedgame");
			}
		}
	},

	search: function() {
		if (this.unable()) {
			return;
		}

		let binding = {
			P1:			document.getElementById("P1").value.trim(),
			P2:			document.getElementById("P2").value.trim(),
			relpath:	document.getElementById("relpath").value.trim(),
			dyer:		document.getElementById("dyer").value.trim(),
			DT:			document.getElementById("DT").value.trim(),
			EV:			document.getElementById("EV").value.trim(),
			RO:			document.getElementById("RO").value.trim(),
		};

		for (let key of Object.keys(binding)) {
			if (binding[key] === "") {
				delete binding[key];
			}
		}

		db.select(binding).then(records => this.handle_records(records));
	},

	reimport_selected_game: function() {

		if (this.unable()) {
			return;
		}
		if (!Number.isInteger(this.index) || this.index < 0 || this.index >= this.lookups.length) {
			return;
		}

		this.status_text("Reimporting, please wait...");

		let index = this.index;
		let relpath = this.lookups[index];

		db.reimport(relpath).then(record => {

			this.status_text("Reimport done.");

			if (index < this.records.length && this.records[index].relpath === relpath) {
				this.records[index] = record;
				this.render_visible();
			}

		}).catch((err) => {
			console.log(err);
			this.status_text("Reimport failed.");
		});
	},

	set_preview_from_path: function(relpath) {

		let request_id = ++this.preview_request_id;

		if (typeof relpath !== "string") {
			this.preview_node.destroy_tree();
			this.preview_node = new_node();
			set_thumbnail(this.preview_node);
			return;
		}

		// The main part of this function is async, on the theory that there may be a little lag time when
		// loading the file, which may feel unresponsive. We use increasing request_id vals to avoid stale updates.

		fs.readFile(slashpath.join(config.sgfdir, relpath)).then(buf => {			// The read itself could throw.

			if (request_id !== this.preview_request_id) {
				return;
			}

			let new_root = load_sgf(buf);											// This could throw.

			this.preview_node.destroy_tree();
			this.preview_node = new_root;

			for (let depth = 0; depth < config.preview_depth; depth++) {
				if (this.preview_node.children.length > 0) {
					this.preview_node = this.preview_node.children[0];
				} else {
					break;
				}
			}

			set_thumbnail(this.preview_node);

		}).catch(err => {															// Reachable from the 2 throw locations, above.

			if (request_id !== this.preview_request_id) {
				return;
			}

			console.log("While trying to set preview:", err.toString());
			this.preview_node.destroy_tree();
			this.preview_node = new_node();
			set_thumbnail(this.preview_node);
		});
	},

	set_preview_from_index: function(n) {
		if (Number.isInteger(n) && n >= 0 && n < this.lookups.length) {
			this.set_preview_from_path(this.lookups[n]);
		} else {
			this.set_preview_from_path(null);
		}
	},

	set_selected_game: function(n) {

		let highlighted = document.getElementsByClassName("highlightedgame")[0];

		if (highlighted) {
			highlighted.classList.remove("highlightedgame");
		}

		if (!Number.isInteger(n) || n < 0 || n >= this.lookups.length) {
			this.index = null;
			this.set_preview_from_path(null);
			document.getElementById("path").textContent = "\u00a0";
			return;
		}

		this.index = n;
		this.set_preview_from_index(n);
		document.getElementById("path").textContent = this.lookups[n];

		let gamesbox = document.getElementById("gamesbox");
		let row_h = this.row_height;
		let target_top = n * row_h;
		let target_bottom = target_top + row_h;

		if (target_top < gamesbox.scrollTop) {
			gamesbox.scrollTop = target_top;
		} else if (target_bottom > gamesbox.scrollTop + gamesbox.clientHeight) {
			gamesbox.scrollTop = target_bottom - gamesbox.clientHeight;
		}

		this.render_visible();
	},

	open_file_from_index: function(n) {
		if (Number.isInteger(n) && n >= 0 && n < this.lookups.length) {
			let relpath = this.lookups[n];
			shell.openPath(slashpath.join(config.sgfdir, relpath));
		}
	},

	open_preview_file: function() {
		if (Number.isInteger(this.index) && this.index >= 0 && this.index < this.lookups.length) {
			shell.openPath(slashpath.join(config.sgfdir, this.lookups[this.index]));
		}
	},

	prev_node: function() {

		if (!this.preview_node.parent) {
			return;
		}

		this.preview_node = this.preview_node.parent;
		set_thumbnail(this.preview_node);
	},

	next_node: function() {

		if (this.preview_node.children.length === 0) {
			return;
		}

		this.preview_node = this.preview_node.children[0];
		set_thumbnail(this.preview_node);
	},

};



module.exports = init();
