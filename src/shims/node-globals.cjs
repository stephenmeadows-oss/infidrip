"use strict";

const { Buffer } = require("buffer");
const process = require("process");

globalThis.Buffer = Buffer;
if (!globalThis.process) globalThis.process = process;
