/*
 * Minimal CEP CSInterface bridge.
 * Adobe exposes window.__adobe_cep__ inside CEP panels; this wrapper provides
 * the evalScript method used by EditFlow without depending on a global sample
 * library being installed elsewhere.
 */
(function(global) {
    if (global.CSInterface) return;

    function CSInterface() {}

    CSInterface.prototype.evalScript = function(script, callback) {
        if (!global.__adobe_cep__ || typeof global.__adobe_cep__.evalScript !== 'function') {
            if (callback) callback('EvalScript error.');
            return;
        }
        global.__adobe_cep__.evalScript(script, callback || function() {});
    };

    global.CSInterface = CSInterface;
})(window);
