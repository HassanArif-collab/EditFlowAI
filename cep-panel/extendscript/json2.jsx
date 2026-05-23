/*
 * json2.jsx - JSON polyfill for ExtendScript
 * ExtendScript lacks native JSON support. This is a minimal implementation
 * of JSON.parse and JSON.stringify based on Douglas Crockford's json2.js.
 */
if (typeof JSON === 'undefined') {
    JSON = {};
}

if (typeof JSON.stringify !== 'function') {
    JSON.stringify = function(value, replacer, space) {
        var indent = '';
        var rep;

        if (typeof space === 'number') {
            for (var i = 0; i < space; i++) {
                indent += ' ';
            }
        } else if (typeof space === 'string') {
            indent = space;
        }

        if (replacer && typeof replacer !== 'function' &&
                (typeof replacer !== 'object' || typeof replacer.length !== 'number')) {
            throw new Error('JSON.stringify');
        }

        function str(key, holder) {
            var value = holder[key];
            var partial = [];

            if (value && typeof value === 'object' && typeof value.toJSON === 'function') {
                value = value.toJSON(key);
            }

            if (value === null) return 'null';
            if (value === undefined) return undefined;

            switch (typeof value) {
                case 'string':
                    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
                case 'number':
                    return isFinite(value) ? String(value) : 'null';
                case 'boolean':
                    return String(value);
                case 'object':
                    if (value === null) return 'null';

                    if (value instanceof Array) {
                        for (var i = 0; i < value.length; i++) {
                            var v = str(i, value);
                            partial[i] = v === undefined ? 'null' : v;
                        }
                        return partial.length === 0 ? '[]' :
                            indent ? '[\n' + indent + partial.join(',\n' + indent) + '\n' + ']' :
                            '[' + partial.join(',') + ']';
                    }

                    var keys = [];
                    for (var k in value) {
                        if (value.hasOwnProperty(k)) {
                            keys.push(k);
                        }
                    }

                    for (var i = 0; i < keys.length; i++) {
                        var k = keys[i];
                        var v = str(k, value);
                        if (v !== undefined) {
                            partial.push(JSON.stringify(k) + (indent ? ': ' : ':') + v);
                        }
                    }

                    return partial.length === 0 ? '{}' :
                        indent ? '{\n' + indent + partial.join(',\n' + indent) + '\n' + '}' :
                        '{' + partial.join(',') + '}';
            }
        }

        return str('', {'': value});
    };
}

if (typeof JSON.parse !== 'function') {
    JSON.parse = function(text, reviver) {
        var j;
        try {
            j = eval('(' + text + ')');
        } catch (e) {
            throw new SyntaxError('JSON.parse');
        }

        if (typeof reviver === 'function') {
            function walk(holder, key) {
                var value = holder[key];
                if (value && typeof value === 'object') {
                    for (var k in value) {
                        if (value.hasOwnProperty(k)) {
                            var v = walk(value, k);
                            if (v !== undefined) {
                                value[k] = v;
                            } else {
                                delete value[k];
                            }
                        }
                    }
                }
                return reviver.call(holder, key, value);
            }
            return walk({'': j}, '');
        }

        return j;
    };
}
