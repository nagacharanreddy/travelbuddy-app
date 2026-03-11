(function () {
  window.elementSdk = {
    init(handler) {
      if (handler && typeof handler.onConfigChange === "function") {
        Promise.resolve().then(function () {
          handler.onConfigChange(handler.defaultConfig || {});
        });
      }

      return {
        isOk: true
      };
    }
  };
})();
