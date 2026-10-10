"use strict";

const { pipeline: pipelineCallback } = require("stream");

function pipeline() {
  const streams = Array.prototype.slice.call(arguments);
  return new Promise(function (resolve, reject) {
    pipelineCallback.apply(null, streams.concat([function (err) {
      if (err) reject(err);
      else resolve();
    }]));
  });
}

module.exports = { pipeline: pipeline };
