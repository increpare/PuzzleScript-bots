'use strict';
// The workshop's stand-in for the editor's js/storagewrapper.js: the same five functions, which
// are all the editor uses to keep things between visits.
//
// Inside Discord's frame a browser may refuse a page its own storage, and the editor must still
// load, so whatever the browser will not keep is kept in memory for as long as the page is open.
//
// The editor's two save lists ('saves' and 'autosaves') are the exception. Once the workshop has
// fetched the room's lists (shareSaves), the editor reads those, and what it writes is handed to
// the workshop to send to the bot: SAVE and the Load dropdown then belong to the room.
var workshopStorage = (function () {
  var memory = Object.create(null);
  var room = null;      // { saves, autosaves }: each the list as the JSON text the editor expects, or null
  var onRoomWrite = null;
  function browserStorage() {
    try { return window.localStorage; } catch (e) { return null; }
  }
  var isRoomKey = function (key) { return room !== null && (key === 'saves' || key === 'autosaves'); };
  return {
    get: function (key) {
      if (isRoomKey(key)) return room[key];
      if (key in memory) return memory[key];
      try { return browserStorage().getItem(key); } catch (e) { return null; }
    },
    set: function (key, value) {
      if (isRoomKey(key)) {
        room[key] = String(value);
        onRoomWrite(key, String(value));
        return;
      }
      try { browserStorage().setItem(key, value); delete memory[key]; } catch (e) { memory[key] = String(value); }
    },
    remove: function (key) {
      if (isRoomKey(key)) return; // nothing in the editor removes saves, and one browser must not empty the room's
      delete memory[key];
      try { browserStorage().removeItem(key); } catch (e) { /* it was only ever in memory */ }
    },
    // lists: { saves: [...], autosaves: [...] } as the bot holds them.
    // onWrite(group, json): the editor has written that list, as JSON text.
    shareSaves: function (lists, onWrite) {
      room = { saves: null, autosaves: null };
      onRoomWrite = onWrite;
      this.setRoomSaves(lists);
    },
    setRoomSaves: function (lists) {
      room.saves = lists.saves.length ? JSON.stringify(lists.saves) : null;
      room.autosaves = lists.autosaves.length ? JSON.stringify(lists.autosaves) : null;
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
