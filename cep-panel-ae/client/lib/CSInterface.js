/*
 * Minimal CEP CSInterface bridge for EditFlow AI.
 * Adobe exposes window.__adobe_cep__ inside CEP panels; this wrapper provides
 * the evalScript method used by EditFlow without depending on a global sample
 * library being installed elsewhere.
 */
(function(global) {
    if (global.CSInterface) return;

    function CSInterface() {}

    CSInterface.prototype.evalScript = function(script, callback) {
        if (!global.__adobe_cep__ || typeof global.__adobe_cep__.evalScript !== 'function') {
            if (callback) {
                callback(JSON.stringify({
                    success: false,
                    error: 'Adobe CEP bridge unavailable. Open EditFlow AI inside Premiere Pro from Window > Extensions, not in a normal browser.',
                    bridgeAvailable: false
                }));
            }
            return;
        }
        global.__adobe_cep__.evalScript(script, callback || function() {});
    };

    CSInterface.prototype.getSystemPath = function(pathType) {
        var path = '';
        if (global.__adobe_cep__) {
            path = global.__adobe_cep__.getSystemPath(pathType);
        }
        return path;
    };

    // System path types
    CSInterface.prototype.SYSTEM_PATH = {
        USER_DATA: 'userData',
        COMMON_FILES: 'commonFiles',
        MY_DOCUMENTS: 'myDocuments',
        APPLICATION: 'application',
        EXTENSION: 'extension',
        HOST_APPLICATION: 'hostApplication'
    };

    global.CSInterface = CSInterface;
})(window);
