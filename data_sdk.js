(function () {
  const apiBase = "/api/data";
  let handler = null;

  async function request(url, options) {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        isOk: false,
        error: payload.error || "Request failed."
      };
    }

    return payload;
  }

  async function refresh() {
    if (!handler || typeof handler.onDataChanged !== "function") {
      return;
    }

    const result = await request(apiBase, { method: "GET" });
    if (result.isOk) {
      handler.onDataChanged(result.data || []);
    }
  }

  window.dataSdk = {
    async init(nextHandler) {
      handler = nextHandler || null;
      const result = await request(apiBase, { method: "GET" });
      if (result.isOk && handler && typeof handler.onDataChanged === "function") {
        handler.onDataChanged(result.data || []);
      }

      return {
        isOk: !!result.isOk,
        data: result.data || [],
        error: result.error
      };
    },

    async create(record) {
      const result = await request(apiBase, {
        method: "POST",
        body: JSON.stringify(record || {})
      });
      if (result.isOk) {
        await refresh();
      }
      return result;
    },

    async update(record) {
      const id = record && record.__backendId;
      if (!id) {
        return {
          isOk: false,
          error: "Missing __backendId for update."
        };
      }

      const result = await request(`${apiBase}/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(record)
      });
      if (result.isOk) {
        await refresh();
      }
      return result;
    },

    async remove(id) {
      const result = await request(`${apiBase}/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      if (result.isOk) {
        await refresh();
      }
      return result;
    },

    async list() {
      return request(apiBase, { method: "GET" });
    }
  };
})();
