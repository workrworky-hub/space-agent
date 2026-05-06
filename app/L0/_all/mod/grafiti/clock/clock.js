/**
 * Simple clock widget for Space Agent.
 * Shows current local time, date, and timezone, updated every second.
 */

function buildStore() {
  return {
    time: "--:--:--",
    date: "",
    zone: "",
    _timer: null,

    mount() {
      this._tick();
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(() => this._tick(), 1000);
    },

    _tick() {
      const now = new Date();
      this.time = now.toLocaleTimeString(undefined, { hour12: false });
      this.date = now.toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      try {
        this.zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      } catch (_) {
        this.zone = "";
      }
    },
  };
}

function register() {
  if (!window.Alpine) return false;
  if (window.Alpine.store && window.Alpine.store("clock")) return true;
  window.Alpine.store("clock", buildStore());
  return true;
}

if (!register()) {
  document.addEventListener("alpine:init", register, { once: true });
}
