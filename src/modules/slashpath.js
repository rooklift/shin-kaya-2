"use strict";

const path = require("path");
const { replace_all } = require("./utils");

// I want to consistently return "/" separated paths regardless of platform.
// This module has wrappers for several "path" methods to do this...

function slashify(s) {
	if (global.process && global.process.platform === "win32") {
		return replace_all(s, "\\", "/");
	}
	return s;
}

exports.basename = path.basename;

exports.dirname = (s) => {
	return slashify(path.dirname(s));
};

exports.join = (...args) => {
	return slashify(path.join(...args));
};

exports.relative = (a, b) => {
	return slashify(path.relative(a, b));
};

exports.resolve = (...args) => {
	return slashify(path.resolve(...args));
};
