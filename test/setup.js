// Loads main.js and pip-main.js outside Obsidian and Electron: their imports
// are stood in for, so the parts that don't need a window can be tested.
const { mock } = require("bun:test")
const path = require("path")

class TFile {
  constructor(p) {
    this.path = p
    this.extension = p.split(".").pop()
    this.basename = path.basename(p).replace(/\.[^.]+$/, "")
  }
}
const stub = () => class {}
mock.module("obsidian", () => ({
  Menu: stub(),
  Notice: stub(),
  Plugin: stub(),
  PluginSettingTab: stub(),
  SettingGroup: stub(),
  TFile,
  requestUrl: () => Promise.reject(new Error("no network in tests")),
  setIcon: () => {},
}))
mock.module("electron", () => ({ BrowserWindow: stub(), screen: {}, systemPreferences: {} }))
globalThis.window = globalThis.window || {
  matchMedia: () => ({ matches: false }),
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
}

const Muta = require("../main.js")
const pip = require("../pip-main.js")
module.exports = { Muta, testing: Muta.testing, pip, TFile }
