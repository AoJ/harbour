var upnode = require('upnode');
var dnode = require('dnode');
var semver = require('semver');
var EventEmitter = require('events').EventEmitter;

exports.connect = function () {
    var argv = [].slice.call(arguments).reduce(function (acc, arg) {
        if (arg && typeof arg === 'object' && arg.secret) {
            acc.secret = arg.secret;
        }
        acc.args.push(arg);
        return acc;
    }, { args : [] });
    
    argv.args.push(function (remote, conn) {
        if (remote.auth) {
            remote.auth(argv.secret, function (err, res) {
                if (err) self.emit('error', new Error(err));
                else conn.emit('up', res);
            });
        }
        else conn.emit('up', remote)
    });
    
    var up = upnode.connect.apply(null, argv.args);
    
    var self = new EventEmitter;
    self.up = up;
    self.close = up.close.bind(up);
    
    [ 'free', 'query', 'assume', 'get', 'service' ]
        .forEach(function (name) {
            self[name] = function () {
                var args = [].slice.call(arguments);
                
                up(function (remote) {
                    remote[name].apply(null, args);
                });
            };
        })
    ;
    
    self.allocate = function () {
        var args = [].slice.call(arguments);
        var fn = args[args.length - 1];
        if (fn.length === 1) {
            args[args.length - 1] = function (port, ready) {
                fn(port);
                ready();
            };
        }
        
        up(function (remote) {
            remote.allocate.apply(null, args);
        });
    };
    
    self.service = function (role, fn) {
        self.allocate(role, function (port, ready) {
            up.on('up', function () {
                self.assume(role, port);
            });
            
            fn(port, ready);
            if (fn.length === 1) ready();
        });
    };
    
    return self;
}

exports.createServer = function (opts) {
    if (typeof opts === 'function') {
        fn = opts;
        opts = {};
    }
    if (!opts) opts = {};
    if (!opts.range) opts.range = { '*' : [ 10000, 20000 ] } ;
    
    var server = dnode(function (remote, conn) {
        if (!opts.secret) return service(remote, conn);
        
        this.auth = function (secret, cb) {
            if (secret === opts.secret) cb(null, service(remote, conn))
            else cb('ACCESS DENIED')
        };
    });
    
    var ports = server.ports = {};
    var roles = server.roles = {};
    
    function service (remote, conn) {
        var self = {};
        var allocatedPorts = [];
        
        conn.on('ready', onready);
        function onready () {
            addr = conn.stream.remoteAddress;
            if (!ports[addr]) ports[addr] = [];
        }
        if (conn.stream) onready();
        
        conn.on('end', function () {
            allocatedPorts.forEach(function (port) {
                self.free(port);
            });
        });
        
        self.allocate = function (roleVer, n, cb) {
            var role = roleVer.split('@')[0];
            var version = roleVer.split('@')[1] || '0.0.0';
            
            if (typeof n === 'function') {
                cb = n;
                n = 1;
            }
            if (typeof cb !== 'function') return;
            if (!roles[role]) roles[role] = [];
            
            var r = opts.range[addr] || opts.range['*'];
            
            var port;
            do {
                port = Math.floor(Math.random() * (r[1] - r[0])) + r[0];
            } while (ports[addr][port]);
            
            function ready () {
                ports[addr].push(port);
                roles[role].push({
                    host : addr,
                    port : port,
                    version : version,
                });
                allocatedPorts.push(port);
                
                server.emit('allocate', {
                    role : role,
                    host : addr,
                    port : port,
                    version : version,
                });
            }
            
            cb(port, ready);
        };
        
        self.assume = function (roleVer, port, cb) {
            var role = roleVer.split('@')[0];
            var version = roleVer.split('@')[1];
            
            var ix = ports[addr].indexOf(port);
            if (ix >= 0) ports[addr].splice(ix, 1);
            ports[addr].push(port);
            allocatedPorts.push(port);
            
            roles[role] = (roles[role] || []).filter(function (r) {
                return r.port !== port;
            });
            roles[role].push({
                host : addr,
                port : port,
                version : version,
            });
            
            server.emit('assume', {
                role : role,
                host : addr,
                port : port, 
                version : version,
            });
            if (cb) cb();
        };
        
        self.free = function (port, cb) {
            if (ports[addr]) {
                var ix = ports[addr].indexOf(port);
                if (ix >= 0) ports[addr].splice(ix, 1);
            }
            
            var found;
            
            Object.keys(roles).forEach(function (role) {
                var rs = roles[role];
                roles[role] = rs.filter(function (r) {
                    var x = !(r.port === port && r.host === addr);
                    if (!x) {
                        found = { role : role, version : r.version };
                    }
                    return x;
                });
            });
            
            if (typeof cb === 'function') cb();
            server.emit('free', {
                role : found && found.role,
                version : found && found.version,
                host : addr,
                port : port,
            });
        };
        
        self.query = function (role, cb) {
            if (typeof role === 'function') {
                cb = role;
                role = undefined;
            }
            cb(server.query(role));
        };
        
        self.get = function (role, cb) {
            if (typeof role === 'function') {
                cb = role;
                role = undefined;
            }
            var ps = server.query(role);
            
            if (ps.length > 0) cb(ps)
            else {
                function onalloc (alloc) {
                    ps = server.query(role);
                    if (ps.length > 0) {
                        server.removeListener('allocate', onalloc);
                        server.removeListener('assume', onalloc);
                        cb(ps);
                    }
                }
                server.on('allocate', onalloc);
                server.on('assume', onalloc);
            }
        };
        
        return self;
    }
    
    server.query = function (roleVer) {
        if (roleVer === undefined) {
            return roles;
        }
        else {
            var role = roleVer.split('@')[0];
            var version = roleVer.split('@')[1];
            
            if (version === undefined) {
                return roles[role] || [];
            }
            else {
                return (roles[role] || []).filter(function (r) {
                    return semver.satisfies(r.version, version);
                });
            }
        }
    };
    
    server.use(upnode.ping);
    return server;
};
