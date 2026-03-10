const path = require('path');
const { BrowserWindow, app, screen } = require('electron');

const EVENT_CHANNEL = 'morning-reading-channel';

let settingsWin = null;
let pluginApi = null;
let boardWin = null;
let buttonWin = null;
let activeBoard = null;
let toplayerApi = null;
const WIDGET_ID = 'morning-reading-board';
const log = (...args) => { try { const enabled = (process.env.LP_DEBUG); if (enabled) console.log('[MorningReading]', ...args); } catch (e) {} };

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 1240,
    height: 640,
    frame: false,
    show: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(app.getAppPath(), 'src', 'preload', 'settings.js')
    }
  });
  settingsWin.loadFile(path.join(__dirname, 'index.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
  return settingsWin;
}

function computeTimesFromPeriods(periods) {
  const list = Array.isArray(periods) ? periods : [];
  const times = new Set();
  for (const p of list) {
    const start = String(p?.start || '').slice(0,5);
    const end = String(p?.end || '').slice(0,5);
    if (/^\d{2}:\d{2}$/.test(start)) times.add(start);
    if (/^\d{2}:\d{2}$/.test(end)) times.add(end);
  }
  return Array.from(times);
}

function handleMinuteTrigger(curHHMM) {
  try {
    if (!pluginApi) return;
    const d = new Date();
    const weekday = d.getDay() === 0 ? 7 : d.getDay();
    const cfg = pluginApi.store.getAll() || {};
    const periods = Array.isArray(cfg.periods) ? cfg.periods : [];
    const boardPeriods = Array.isArray(cfg.boardPeriods) ? cfg.boardPeriods : [];
    log('trigger', curHHMM, { weekday });

    const base = pluginApi.store.get('system', 'semesterStart') || pluginApi.store.get('system', 'offsetBaseDate');
    const biweekOff = !!pluginApi.store.get('system', 'biweekOffset');
    let isEvenWeek = null;
    if (base) {
      try {
        const baseDate = new Date(base + 'T00:00:00');
        const diffDays = Math.floor((d - baseDate) / (24 * 3600 * 1000));
        const weekIndex = Math.floor(diffDays / 7);
        isEvenWeek = weekIndex % 2 === 0;
        if (biweekOff) isEvenWeek = !isEvenWeek;
      } catch (e) {}
    }
    const matchBiweek = (rule) => {
      if (rule === 'any' || rule == null) return true;
      if (isEvenWeek == null) return false;
      return rule === 'even' ? isEvenWeek : !isEvenWeek;
    };

    const payloads = [];
    for (const p of periods) {
      if (p?.enabled === false) continue;
      const onWeekday = Array.isArray(p?.weekdays) ? p.weekdays.includes(weekday) : true;
      const biweekOk = matchBiweek(p?.biweek);
      const start = String(p?.start || '').slice(0,5);
      const end = String(p?.end || '').slice(0,5);
      log('consider', p?.name || '', { start, end, weekdays: p?.weekdays, biweek: p?.biweek, onWeekday, biweekOk });
      if (!onWeekday || !biweekOk) continue;
      if (start === curHHMM) {
        const speakStart = (p?.speakStart === true ? true : false);
        const which = (p?.soundIn !== false ? 'in' : 'none');
        const text = String(p?.textStart || '早读开始，请站立朗读');
        log('match:start', p?.name || '', { speakStart, which, text });
        payloads.push({ mode: 'overlay.text', text, duration: 5000, animate: 'fade', speak: speakStart, which });
      }
      if (end === curHHMM) {
        const speakEnd = (p?.speakEnd === true ? true : false);
        const which = (p?.soundOut !== false ? 'out' : 'none');
        const title = String(p?.textEnd || '早读结束');
        const subText = String(p?.subTextEnd || '请坐下休息');
        log('match:end', p?.name || '', { speakEnd, which, title, subText });
        payloads.push({ mode: 'toast', title, subText, type: 'info', duration: 4000, speak: speakEnd, which });
      }
    }
    for (const p of boardPeriods) {
      if (p?.enabled === false) continue;
      const onWeekday = Array.isArray(p?.weekdays) ? p.weekdays.includes(weekday) : true;
      const biweekOk = matchBiweek(p?.biweek);
      const start = String(p?.start || '').slice(0,5);
      const end = String(p?.end || '').slice(0,5);
      if (!onWeekday || !biweekOk) continue;
      if (start === curHHMM) {
        try { openBoardWindow(p); } catch (e) {}
      }
      if (end === curHHMM) {
        try { closeBoardWidget(); } catch (e) {}
      }
    }
    log('enqueueBatch:size', payloads.length);
    if (payloads.length && pluginApi) {
      try {
        Promise.resolve(pluginApi.call('notify-plugin', 'enqueueBatch', [payloads]))
          .then((res) => { try { log('notify:result', !!res?.ok, res?.error || null); } catch (e) {} })
          .catch((e) => { try { log('notify:error', e?.message || String(e)); } catch (e) {} });
      } catch (e) { try { log('notify:call:thrown', e?.message || String(e)); } catch (e) {} }
    }
  } catch (e) {}
}

async function openBoardWindow(period) {
  try {
    const p = (period && typeof period === 'object') ? period : null;
    activeBoard = p;
    
    // Close any existing board widget in toplayer
    closeBoardWidget();
    
    // Create independent window for the board
    const d = screen.getPrimaryDisplay();
    const b = d.bounds;
    const win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      backgroundColor: '#0b1520',
      show: true,
      resizable: true,
      fullscreen: true,
      webPreferences: { 
        nodeIntegration: true, 
        contextIsolation: false, 
        webSecurity: false,
        webviewTag: true
      }
    });
    boardWin = win;
    win.loadFile(path.join(__dirname, 'board.html'));
    win.on('closed', () => { boardWin = null; try { if (isBoardPeriodActive()) openOpenButton(); } catch (e) {} });
    return win;
  } catch (e) { return null; }
}

async function showBoardWidget() {
  // This function is no longer used for the main board
  // The board is now shown in an independent window
}

function closeBoardWidget() {
  if (toplayerApi && toplayerApi.removeWidget) {
    toplayerApi.removeWidget(WIDGET_ID);
  }
}

async function openOpenButton() {
  try {
    if (!toplayerApi || !toplayerApi.isRunning()) {
      log('toplayer not available, falling back to independent window');
      return openOpenButtonFallback();
    }
    
    const d = screen.getPrimaryDisplay();
    const b = d.bounds;
    const w = 160, h = 56;
    const x = b.x + Math.floor((b.width - w) / 2);
    const y = b.y + b.height - h - 100;
    
    const buttonUrl = require('url').format({
      pathname: path.join(__dirname, 'open-button.html'),
      protocol: 'file:',
      slashes: true
    });
    
    const result = toplayerApi.addWidget({
      id: 'morning-reading-open-button',
      x: x,
      y: y,
      width: w,
      height: h,
      url: buttonUrl,
      nodeIntegration: true,
      preload: path.join(__dirname, 'preload.js')
    });
    
    log('addWidget result:', result);
    return result;
  } catch (e) { 
    log('openOpenButton error:', e);
    return openOpenButtonFallback();
  }
}

async function openOpenButtonFallback() {
  try {
    if (buttonWin && !buttonWin.isDestroyed()) return buttonWin;
    
    const d = screen.getPrimaryDisplay();
    const b = d.bounds;
    const w = 160, h = 56;
    const win = new BrowserWindow({
      x: b.x + Math.floor((b.width - w) / 2),
      y: b.y + b.height - h - 100,
      width: w,
      height: h,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: { 
        nodeIntegration: true, 
        contextIsolation: false, 
        webSecurity: false,
        preload: path.join(__dirname, 'preload.js') 
      }
    });
    buttonWin = win;
    win.loadFile(path.join(__dirname, 'open-button.html'));
    win.on('closed', () => { buttonWin = null; });
    return win;
  } catch (e) { return null; }
}

async function showOpenButtonWidget() {
  // Not used - using independent window instead
}

function closeOpenButtonWidget() {
  try {
    if (toplayerApi && toplayerApi.isRunning()) {
      toplayerApi.removeWidget('morning-reading-open-button');
    }
    if (buttonWin && !buttonWin.isDestroyed()) {
      buttonWin.close();
    }
  } catch (e) {}
}

function isBoardPeriodActive() {
  try {
    if (!pluginApi) return false;
    const now = new Date();
    const weekday = now.getDay() === 0 ? 7 : now.getDay();
    const cfg = pluginApi.store.getAll() || {};
    const boardPeriods = Array.isArray(cfg.boardPeriods) ? cfg.boardPeriods : [];
    const base = pluginApi.store.get('system', 'semesterStart') || pluginApi.store.get('system', 'offsetBaseDate');
    const biweekOff = !!pluginApi.store.get('system', 'biweekOffset');
    let isEvenWeek = null;
    if (base) {
      try {
        const baseDate = new Date(base + 'T00:00:00');
        const diffDays = Math.floor((now - baseDate) / (24 * 3600 * 1000));
        const weekIndex = Math.floor(diffDays / 7);
        isEvenWeek = weekIndex % 2 === 0;
        if (biweekOff) isEvenWeek = !isEvenWeek;
      } catch (e) {}
    }
    const matchBiweek = (rule) => { if (rule === 'any' || rule == null) return true; if (isEvenWeek == null) return false; return rule === 'even' ? isEvenWeek : !isEvenWeek; };
    const hh = now.getHours().toString().padStart(2, '0');
    const mm = now.getMinutes().toString().padStart(2, '0');
    const cur = `${hh}:${mm}`;
    for (const p of boardPeriods) {
      if (p?.enabled === false) continue;
      const onWeekday = Array.isArray(p?.weekdays) ? p.weekdays.includes(weekday) : true;
      const biweekOk = matchBiweek(p?.biweek);
      const start = String(p?.start || '').slice(0,5);
      const end = String(p?.end || '').slice(0,5);
      if (!onWeekday || !biweekOk) continue;
      if (/^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end)) {
        if (start <= cur && cur < end) return true;
      }
    }
    return false;
  } catch (e) { return false; }
}

module.exports = {
  name: 'morning-reading',
  version: '1.0.0',
  init: (api) => {
    pluginApi = api;
    try {
      const defaults = { periods: [], boardPeriods: [] };
      const cfg = api.store.getAll() || {};
      let changed = false;
      Object.keys(defaults).forEach(k => {
        if (!(k in cfg)) {
          cfg[k] = defaults[k];
          changed = true;
        }
      });
      if (changed) api.store.setAll(cfg);

      if (api.automation) {
        const times = Array.from(new Set([
          ...computeTimesFromPeriods(cfg.periods || []),
          ...computeTimesFromPeriods(cfg.boardPeriods || [])
        ]));
        api.automation.registerMinuteTriggers(times, handleMinuteTrigger);
      }
      
      if (pluginApi.call) {
        pluginApi.call('service-toplayer', 'isRunning', []).then(running => {
          if (running) {
            toplayerApi = {
              isRunning: () => running,
              addWidget: (opts) => pluginApi.call('service-toplayer', 'addWidget', [opts]),
              removeWidget: (id) => pluginApi.call('service-toplayer', 'removeWidget', [id]),
              updateWidget: (id, bounds) => pluginApi.call('service-toplayer', 'updateWidget', [id, bounds]),
              startDrag: (id) => pluginApi.call('service-toplayer', 'startDrag', [id]),
              endDrag: (id, x, y) => pluginApi.call('service-toplayer', 'endDrag', [{ id, x, y }]),
              forceToFront: () => pluginApi.call('service-toplayer', 'forceToFront', []),
              getWidget: (id) => pluginApi.call('service-toplayer', 'getWidget', [id])
            };
          }
        }).catch(() => {});
      }
      
      if (isBoardPeriodActive()) openBoardWindow(null);
    } catch (e) {}
  },
  functions: {
    openSettings: () => { openSettingsWindow(); return true; },
    setSchedule: (periods) => {
      try {
        if (!pluginApi) return { ok: false, error: 'plugin_api_unavailable' };
        if (!pluginApi.automation) return { ok: false, error: 'automation_api_unavailable' };
        const cfg = pluginApi.store.getAll() || {};
        const times = Array.from(new Set([
          ...computeTimesFromPeriods(Array.isArray(periods) ? periods : []),
          ...computeTimesFromPeriods(cfg.boardPeriods || [])
        ]));
        return pluginApi.automation.registerMinuteTriggers(times, handleMinuteTrigger);
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
    setBoardSchedule: (periods) => {
      try {
        if (!pluginApi) return { ok: false, error: 'plugin_api_unavailable' };
        if (!pluginApi.automation) return { ok: false, error: 'automation_api_unavailable' };
        const cfg = pluginApi.store.getAll() || {};
        const times = Array.from(new Set([
          ...computeTimesFromPeriods(cfg.periods || []),
          ...computeTimesFromPeriods(Array.isArray(periods) ? periods : [])
        ]));
        return pluginApi.automation.registerMinuteTriggers(times, handleMinuteTrigger);
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
    clearSchedule: () => {
      try { 
        if (!pluginApi) return { ok: false, error: 'plugin_api_unavailable' };
        if (!pluginApi.automation) return { ok: false, error: 'automation_api_unavailable' };
        return pluginApi.automation.clearMinuteTriggers(); 
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
    listScheduleTimes: () => {
      try { 
        if (!pluginApi) return { ok: true, times: [] };
        if (!pluginApi.automation) return { ok: true, times: [] };
        return pluginApi.automation.listMinuteTriggers(); 
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
    openBoard: () => { try { openBoardWindow(null); return true; } catch (e) { return { ok: false, error: e?.message || String(e) }; } },
    closeBoard: () => { 
      try { 
        if (buttonWin && !buttonWin.isDestroyed()) buttonWin.close();
        if (boardWin && !boardWin.isDestroyed()) boardWin.close();
        return true; 
      } catch (e) { return { ok: false, error: e?.message || String(e) }; } 
    },
    ensureOpenButton: () => { try { if (isBoardPeriodActive()) openOpenButton(); return true; } catch (e) { return { ok: false, error: e?.message || String(e) }; } },
    setOpenButtonDragging: (flag) => { 
      try { 
        if (toplayerApi && toplayerApi.isRunning()) {
          if (flag) {
            toplayerApi.startDrag('morning-reading-open-button');
          }
        }
        return !!flag; 
      } catch (e) { return false; } 
    },
    getOpenButtonBounds: () => { 
      try { 
        if (toplayerApi && toplayerApi.isRunning()) {
          const widget = toplayerApi.getWidget && toplayerApi.getWidget('morning-reading-open-button');
          if (widget && widget.bounds) {
            return { x: widget.bounds.x, y: widget.bounds.y, width: widget.bounds.width, height: widget.bounds.height };
          }
        }
        if (!buttonWin || buttonWin.isDestroyed()) return null; 
        return buttonWin.getBounds(); 
      } catch (e) { return null; } 
    },
    moveOpenButtonTo: (x, y) => {
      try {
        if (toplayerApi && toplayerApi.isRunning()) {
          toplayerApi.updateWidget('morning-reading-open-button', { x, y });
          return true;
        }
        if (!buttonWin || buttonWin.isDestroyed()) return false;
        const d = screen.getPrimaryDisplay();
        const sb = d.bounds; const wb = buttonWin.getBounds();
        const nx = Math.max(sb.x, Math.min(x, sb.x + sb.width - wb.width));
        const ny = Math.max(sb.y, Math.min(y, sb.y + sb.height - wb.height));
        buttonWin.setPosition(Math.floor(nx), Math.floor(ny));
        return true;
      } catch (e) { return false; }
    },
    snapOpenButton: () => {
      try {
        let bounds = null;
        if (toplayerApi && toplayerApi.isRunning()) {
          const widget = toplayerApi.getWidget && toplayerApi.getWidget('morning-reading-open-button');
          if (widget && widget.bounds) {
            bounds = widget.bounds;
          }
        } else if (buttonWin && !buttonWin.isDestroyed()) {
          bounds = buttonWin.getBounds();
        }
        if (!bounds) return false;
        
        const d = screen.getPrimaryDisplay();
        const b = d.bounds;
        const th = 24;
        let x = bounds.x, y = bounds.y;
        if (Math.abs(bounds.x - b.x) <= th) x = b.x;
        if (Math.abs((bounds.x + bounds.width) - (b.x + b.width)) <= th) x = b.x + b.width - bounds.width;
        if (Math.abs(bounds.y - b.y) <= th) y = b.y;
        if (Math.abs((bounds.y + bounds.height) - (b.y + b.height)) <= th) y = b.y + b.height - bounds.height;
        
        if (x !== bounds.x || y !== bounds.y) {
          if (toplayerApi && toplayerApi.isRunning()) {
            toplayerApi.updateWidget('morning-reading-open-button', { x, y });
          } else if (buttonWin && !buttonWin.isDestroyed()) {
            buttonWin.setPosition(x, y);
          }
        }
        return true;
      } catch (e) { return false; }
    },
    previewStart: async (period) => {
      try {
        const p = (period && typeof period === 'object') ? period : {};
        const payloads = [];
        payloads.push({ mode: 'overlay.text', text: p.textStart || '站立早读开始', duration: 4000, animate: 'fade', speak: (p.speakStart === true ? true : false), which: (p.soundIn !== false ? 'in' : 'none') });
        if (!pluginApi) return { ok: false, error: 'plugin_api_unavailable' };
        return await pluginApi.call('notify-plugin', 'enqueueBatch', [payloads]);
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
    previewEnd: async (period) => {
      try {
        const p = (period && typeof period === 'object') ? period : {};
        const payloads = [];
        payloads.push({ mode: 'toast', title: p.textEnd || '站立早读结束', subText: (p.subTextEnd || '请坐下休息'), type: 'info', duration: 4000, speak: (p.speakEnd === true ? true : false), which: (p.soundOut !== false ? 'out' : 'none') });
        if (!pluginApi) return { ok: false, error: 'plugin_api_unavailable' };
        return await pluginApi.call('notify-plugin', 'enqueueBatch', [payloads]);
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
    getVariable: async (name) => { const k=String(name||''); if (k==='timeISO') return new Date().toISOString(); if (k==='pluginName') return '早读助手'; return ''; },
    listVariables: () => ['timeISO','pluginName']
  }
};
