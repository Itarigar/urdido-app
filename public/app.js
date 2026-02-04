function getToken() {
  return localStorage.getItem("token");
}

function setToken(token) {
  localStorage.setItem("token", token);
}

function logout() {
  localStorage.removeItem("token");
  window.location.href = "/login.html";
}

async function api(url, options = {}) {
  const token = getToken();
  const headers = options.headers || {};
  headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });
  
  // Handle Auth Errors Global
  if (res.status === 401 || res.status === 403) {
      localStorage.removeItem("token");
      window.location.href = "/login.html";
      throw new Error("Sesión expirada. Redirigiendo...");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `Error HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function mustAuth() {
  if (!getToken()) window.location.href = "/login.html";
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// Clock Functionality
function updateClock() {
    const clockEl = document.getElementById('navbar-clock');
    if (!clockEl) return;

    const now = new Date();
    // Format: DD/MM/YYYY HH:mm:ss
    const dateStr = now.toLocaleDateString('es-MX', { 
        day: '2-digit', 
        month: '2-digit', 
        year: 'numeric' 
    });
    const timeStr = now.toLocaleTimeString('es-MX', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
    });

    clockEl.textContent = `${dateStr} ${timeStr}`;
}

// Initialize clock if element exists
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('navbar-clock')) {
        updateClock();
        setInterval(updateClock, 1000);
    }
});
