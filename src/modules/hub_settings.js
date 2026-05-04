"use strict";

const { ipcRenderer } = require("electron");
const db = require("./db_new");
const slashpath = require("./slashpath");

const multichecks = {
	"preview_depth":		["View", "Preview depth (initial)"]
};
const togglechecks = {
	"apply_gogod_fixes": 	["Database", "Fix (most) GoGoD names on import"],
	"deduplicate":			["View", "Deduplicate search results"]
};

for (let menupath of Object.values(multichecks)) {
	ipcRenderer.send("verify_menupath", menupath);
}

for (let menupath of Object.values(togglechecks)) {
	ipcRenderer.send("verify_menupath", menupath);
}

module.exports = {

	set: function(key, value) {

		let old_value = config[key];
		config[key] = value;

		switch (key) {

			case "sgfdir":

				if (!Array.isArray(config.known_dirs)) {
					config.known_dirs = [];
				}
				let spr = slashpath.resolve(value);
				if (!config.known_dirs.includes(spr)) {
					config.known_dirs.push(spr);
				}

				if (db.wip()) {
					config[key] = old_value;
					alert("Unable. Work is in progress.");
				} else {
					db.connect().then(() => this.display_row_count()).catch(err => {
						console.log(err);
						this.status_text(err.toString());
					});
				}
				break;
		}

		if (multichecks.hasOwnProperty(key)) {
			ipcRenderer.send("set_checks", multichecks[key].concat([value]));
		}

		if (togglechecks.hasOwnProperty(key)) {
			ipcRenderer.send(value ? "set_check_true" : "set_check_false", togglechecks[key]);
		}

	},

};
