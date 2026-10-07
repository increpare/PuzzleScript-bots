'use strict';
// The workshop's stand-in for the editor's js/storagewrapper.js: the same five functions, which
// are all the editor uses to keep things between visits.
//
// Inside Discord's frame a browser may refuse a page its own storage, and the editor must still
// load, so whatever the browser will not keep is kept in memory for as long as the page is open.
var workshopStorage = (function () {
  var memory = Object.create(null);
  function browserStorage() {
    try { return window.localStorage; } catch (e) { return null; }
  }
  return {
    get: function (key) {
      if (key in memory) return memory[key];
      try { return browserStorage().getItem(key); } catch (e) { return null; }
    },
    set: function (key, value) {
      try { browserStorage().setItem(key, value); delete memory[key]; } catch (e) { memory[key] = String(value); }
    },
    remove: function (key) {
      delete memory[key];
      try { browserStorage().removeItem(key); } catch (e) { /* it was only ever in memory */ }
    },
  };
})();

function storage_has(key) {
  return workshopStorage.get(key) !== null;
}

function storage_get(key) {
  return workshopStorage.get(key);
}

function storage_get_int(key, defaultValue) {
  var value = parseInt(workshopStorage.get(key), 10);
  return isNaN(value) ? defaultValue : value;
}

function storage_set(key, value) {
  workshopStorage.set(key, value);
}

function storage_remove(key) {
  workshopStorage.remove(key);
}
