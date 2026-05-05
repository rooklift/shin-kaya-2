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

const GAME_ROW_OVERSCAN = 16;
const DEFAULT_GAME_ROW_HEIGHT = 20;

function init() {

	let hub_prototype = {};
	Object.assign(hub_prototype, hub_main_props);
	Object.assign(hub_prototype, require("./hub_settings"));

	let ret = Object.create(hub_prototype);
	ret.displayed_records = [];
	ret.index = null;
	ret.preview_request_id = 0;
	ret.preview_node = new_node();
	ret.game_row_height = null;
	ret.rendered_first_game = null;
	ret.rendered_after_game = null;
	ret.render_animation_frame = null;

	set_thumbnail(ret.preview_node);

	return ret;
}

let hub_main_props = {

	quit: function() {
		config_io.save();					// As long as we use the sync save, this will complete before we
		ipcRenderer.send("terminate");		// send "terminate". Not sure about results if that wasn't so.
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

	record_at: function(n) {
		if (Number.isInteger(n) && n >= 0 && n < this.displayed_records.length) {
			return this.displayed_records[n];
		}
		return null;
	},

	status_text: function(msg) {
		document.getElementById("status").textContent = msg;
	},

	status_html: function(msg) {
		document.getElementById("status").innerHTML = msg;
	},

	display_no_connection: function() {
		this.status_text(`No database open`);
	},

	connect_db: function() {
		if (db.wip()) {
			alert("Unable. Work is in progress.");
			return;
		}
		this.status_text("Loading...");
		db.connect().then(() => {
			this.clear_gamesbox();
			this.display_row_count();
		}).catch(err => {
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

		this.displayed_records = records;

		let count_string = `<span class="bold">${records.length}</span> ${records.length === 1 ? "game" : "games"} shown`;

		if (dedup_count > 0) {
			count_string += `;  deduplicated ${dedup_count} ${dedup_count === 1 ? "game" : "games"}`;
		}

		if (truncated_from) {
			count_string += `;  too many results (${truncated_from})`;
		}

		this.status_html(count_string);
		this.mount_gamesbox();

		this.set_selected_game(null);
	},

	clear_gamesbox: function() {
		this.displayed_records = [];
		this.mount_gamesbox();
		this.set_selected_game(null);
	},

	mount_gamesbox: function() {
		let gamesbox = document.getElementById("gamesbox");
		gamesbox.scrollTop = 0;
		gamesbox.innerHTML = '<div id="gamesbox_top_spacer"></div><div id="gamesbox_rows"></div><div id="gamesbox_bottom_spacer"></div>';
		this.rendered_first_game = null;
		this.rendered_after_game = null;
		this.render_visible_games(true);
	},

	schedule_render_visible_games: function() {
		if (this.render_animation_frame !== null) {
			return;
		}
		this.render_animation_frame = requestAnimationFrame(() => {
			this.render_animation_frame = null;
			this.render_visible_games(false);
		});
	},

	render_visible_games: function(force) {
		let records = this.displayed_records;
		let gamesbox = document.getElementById("gamesbox");
		let top_spacer = document.getElementById("gamesbox_top_spacer");
		let rows = document.getElementById("gamesbox_rows");
		let bottom_spacer = document.getElementById("gamesbox_bottom_spacer");

		if (!records || !top_spacer || !rows || !bottom_spacer) {
			return;
		}

		let row_height = this.get_game_row_height();
		let first = Math.max(0, Math.floor(gamesbox.scrollTop / row_height) - GAME_ROW_OVERSCAN);
		let after = Math.min(records.length, Math.ceil((gamesbox.scrollTop + gamesbox.clientHeight) / row_height) + GAME_ROW_OVERSCAN);

		if (!force && first === this.rendered_first_game && after === this.rendered_after_game) {
			return;
		}

		let lines = [];
		for (let i = first; i < after; i++) {
			lines.push(span_string(records[i], `gamesbox_entry_${i}`));
		}

		top_spacer.style.height = `${first * row_height}px`;
		bottom_spacer.style.height = `${(records.length - after) * row_height}px`;
		rows.innerHTML = lines.join("\n");

		this.rendered_first_game = first;
		this.rendered_after_game = after;

		let measured_row = rows.firstElementChild;
		if (measured_row) {
			let measured_height = measured_row.getBoundingClientRect().height;
			if (measured_height > 0 && Math.abs(measured_height - row_height) > 0.5) {
				this.game_row_height = measured_height;
				this.rendered_first_game = null;
				this.render_visible_games(true);
				return;
			}
		}

		if (Number.isInteger(this.index) && this.index >= first && this.index < after) {
			let highlighted = document.getElementById(`gamesbox_entry_${this.index}`);
			if (highlighted) {
				highlighted.classList.add("highlightedgame");
			}
		}
	},

	get_game_row_height: function() {
		if (this.game_row_height) {
			return this.game_row_height;
		}

		let row = document.querySelector("#gamesbox_rows .game");
		if (row) {
			let height = row.getBoundingClientRect().height;
			if (height > 0) {
				this.game_row_height = height;
				return height;
			}
		}

		return DEFAULT_GAME_ROW_HEIGHT;
	},

	scroll_game_into_view: function(n) {
		let gamesbox = document.getElementById("gamesbox");
		let row_height = this.get_game_row_height();
		let row_top = n * row_height;
		let row_bottom = row_top + row_height;
		let view_top = gamesbox.scrollTop;
		let view_bottom = view_top + gamesbox.clientHeight;

		if (row_top < view_top) {
			gamesbox.scrollTop = row_top;
		} else if (row_bottom > view_bottom) {
			gamesbox.scrollTop = row_bottom - gamesbox.clientHeight;
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
		let selected_record = this.record_at(this.index);
		if (!selected_record) {
			return;
		}

		this.status_text("Reimporting, please wait...");

		let index = this.index;
		let relpath = selected_record.relpath;

		db.reimport(relpath).then(record => {

			this.status_text("Reimport done.");

			let element = document.getElementById(`gamesbox_entry_${index}`);
			this.displayed_records[index] = record;

			if (element) {
				element.outerHTML = span_string(record, `gamesbox_entry_${index}`);

				if (index === this.index) {
					document.getElementById(`gamesbox_entry_${index}`).classList.add("highlightedgame");
				}
			} else {
				this.render_visible_games(true);
			}

		}).catch((err) => {
			console.log(err);
			this.status_text("Reimport failed.");
		});
	},

	set_preview: function() {

		let request_id = ++this.preview_request_id;

		let record = this.record_at(this.index);
		if (!record) {
			this.preview_node.destroy_tree();
			this.preview_node = new_node();
			set_thumbnail(this.preview_node);
			return;
		}

		// The main part of this function is async, on the theory that there may be a little lag time when
		// loading the file, which may feel unresponsive. We use increasing request_id vals to avoid stale updates.

		fs.readFile(slashpath.join(config.sgfdir, record.relpath)).then(buf => {	// The read itself could throw.

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

	set_selected_game: function(n) {

		let highlighted = document.getElementsByClassName("highlightedgame")[0];

		if (highlighted) {
			highlighted.classList.remove("highlightedgame");
		}

		let record = this.record_at(n);
		if (!record) {
			this.index = null;
			this.set_preview();
			document.getElementById("path").textContent = "\u00a0";
			return;
		}

		this.index = n;
		this.set_preview();
		document.getElementById("path").textContent = record.relpath;
		this.scroll_game_into_view(n);
		this.render_visible_games(false);

		let element_to_highlight = document.getElementById(`gamesbox_entry_${n}`);

		if (element_to_highlight) {
			element_to_highlight.classList.add("highlightedgame");
		}
	},

	open_file_from_index: function(n) {
		let record = this.record_at(n);
		if (record) {
			shell.openPath(slashpath.join(config.sgfdir, record.relpath));
		}
	},

	open_preview_file: function() {
		let record = this.record_at(this.index);
		if (record) {
			shell.openPath(slashpath.join(config.sgfdir, record.relpath));
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
