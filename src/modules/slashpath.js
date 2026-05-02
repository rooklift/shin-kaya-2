"use strict";

const path = require("path");
const { replace_all } = require("./utils");

// I want to consistently return "/" separated paths regardless of platform.
// This module has wrappers for several "path" methods to do this...

function slashify(s) {
	if (global.process && global.process.platform === "win32") {
		s = replace_all(s, "\\", "/");
	}
	return s;
}

exports.basename = path.basename;

exports.dirname = (s) => slashify(path.dirname(s));

exports.join = (...args) => slashify(path.join(...args));

exports.relative = (a, b) => slashify(path.relative(a, b));

exports.resolve = (...args) => slashify(path.resolve(...args));
