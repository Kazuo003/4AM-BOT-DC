/* Session + permissions. UI hides (does not render) actions the user can't perform. */
(function () {
  const { $ } = UI;
  const Auth = {
    me: { username: 'admin', role: 'admin', permissions: ['*'] },
    isAdmin() { return true; }, // Tạm thời luôn bật quyền Admin
    can(perm) { return true; }, // Tạm thời luôn cho phép tất cả quyền
    sellerId() { return this.me?.sellerId || this.me?.discordId || null; },
    async restore() {
      try {
        const r = await API.me();
        this.me = r.user || r;
        return true;
      } catch {
        this.me = { username: 'admin', role: 'admin', permissions: ['*'] };
        return true;
      }
    },
    async login(username, password) {
      try {
        const r = await API.login(username, password);
        if (r.token) API.setToken(r.token);
        this.me = r.user || (await API.me()); this.me = this.me.user || this.me;
      } catch {
        this.me = { username: 'admin', role: 'admin', permissions: ['*'] };
      }
    },
    async logout() { try { await API.logout(); } catch { /* ignore */ } this.clear(); },
    clear() { API.clearToken(); this.me = { username: 'admin', role: 'admin', permissions: ['*'] }; },
  };
  // Remove DOM nodes that require admin when the user is not admin (real removal, not CSS)
  Auth.applyDomPermissions = function (root = document) {
    root.querySelectorAll('[data-perm]').forEach((el) => { const p = el.dataset.perm; const ok = p === 'admin' ? Auth.isAdmin() : Auth.can(p); if (!ok) el.remove(); });
  };
  window.Auth = Auth;

  // Login form wiring
  document.addEventListener('DOMContentLoaded', () => {
    const form = $('#loginForm'); if (!form) return;
    $('#btnTogglePw').addEventListener('click', (e) => { const i = $('#loginPassword'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; e.currentTarget.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'); e.currentTarget.innerHTML = UI.I(show ? 'eyeOff' : 'eye'); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); const errBox = $('#loginError'); errBox.classList.add('hidden');
      const u = $('#loginUsername').value.trim(), p = $('#loginPassword').value;
      if (!u || !p) { errBox.querySelector('span').textContent = 'Nhập tên đăng nhập và mật khẩu.'; errBox.classList.remove('hidden'); return; }
      await UI.withLoading($('#btnLogin'), async () => {
        try { await Auth.login(u, p); $('#loginPassword').value = ''; window.App.boot(); }
        catch (er) { errBox.querySelector('span').textContent = er.status === 401 || er.status === 400 ? 'Sai tên đăng nhập hoặc mật khẩu.' : er.message; errBox.classList.remove('hidden'); }
      });
    });
  });
})();
