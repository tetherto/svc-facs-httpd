'use strict'

const async = require('async')
const Base = require('bfx-facs-base')
const Fastify = require('fastify')

const DEFAULT_ROUTES = [
  {
    method: 'GET',
    url: '/echo',
    schema: {
      querystring: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        },
        required: ['value']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            value: { type: 'string' }
          }
        }
      }
    },
    handler: async (request, reply) => {
      return { value: request.query.value }
    }
  }
]

class HttpdFacility extends Base {
  constructor (caller, opts, ctx) {
    super(caller, opts, ctx)

    this.name = 'httpd'
    this._hasConf = true

    this.init()

    this.mem = { plugins: [], routes: [], decorators: [], hooks: [] }
  }

  addRoute (r) {
    if (this.server) {
      throw new Error('ERR_FACS_SERVER_HTTP_ALREADY_INITED')
    }

    this.mem.routes.push(r)
  }

  addDecorator (d) {
    if (this.server) {
      throw new Error('ERR_FACS_SERVER_HTTP_ALREADY_INITED')
    }

    this.mem.decorators.push(d)
  }

  addPlugin (p) {
    if (this.server) {
      throw new Error('ERR_FACS_SERVER_HTTP_ALREADY_INITED')
    }

    this.mem.plugins.push(p)
  }

  addHook (hookName, handler) {
    if (this.server) {
      throw new Error('ERR_FACS_SERVER_HTTP_ALREADY_INITED')
    }

    this.mem.hooks.push({ name: hookName, handler })
  }

  async startServer () {
    if (this.server) {
      throw new Error('ERR_FACS_SERVER_HTTP_CREATE_DUP')
    }

    const fastify = Fastify({
      logger: this.opts.logger,
      trustProxy: this.opts.trustProxy
    })

    this.server = fastify

    if (this.opts.onBadMethod) {
      const methodsByPath = new Map()
      const patternsByHead = new Map()

      function sendByStatusCode (statusCode, method, route) {
        if (statusCode === 404) {
          return {
            message: `Route ${method}:${route} not found`,
            error: 'Not Found',
            statusCode: 404
          }
        }
        if (statusCode === 405) {
          return {
            message: `Route ${method}:${route} method not allowed`,
            error: 'Method Not Allowed',
            statusCode: 405
          }
        }
      }

      function normalize (p) { return (p.split('?')[0] || '/').replace(/\/+$/, '') || '/' }
      function head (p) { const s = normalize(p).split('/').filter(Boolean); return s[0] || '' }
      function toRegex (routePath) {
        const norm = normalize(routePath)
        const esc = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp('^' + esc.replace(/:(\w+)/g, '[^/]+') + '$')
      }

      this.server.addHook('onRoute', (route) => {
        const methods = new Set([].concat(route.method).map(m => String(m).toUpperCase()))
        const p = normalize(route.path)
        if (!p.includes(':') && !p.includes('*')) {
          const set = methodsByPath.get(p) || new Set()
          methods.forEach(m => set.add(m))
          if (!methodsByPath.has(p)) methodsByPath.set(p, set)
        } else {
          const bucket = patternsByHead.get(head(p)) || []
          bucket.push({ regex: toRegex(p), methods })
          patternsByHead.set(head(p), bucket)
        }
      })

      this.server.setNotFoundHandler((req, reply) => {
        const p = normalize(req.url)
        const exact = methodsByPath.get(p)
        if (exact && exact.size) return reply.code(405).header('Allow', [...exact].join(', ')).send(sendByStatusCode(405, req.method, req.url))

        const bucket = patternsByHead.get(head(p)) || []
        const hit = bucket.find(r => r.regex.test(p))
        if (hit) return reply.code(405).header('Allow', [...hit.methods].join(', ')).send(sendByStatusCode(405, req.method, req.url))

        reply.code(404).send(sendByStatusCode(404, req.method, req.url))
      })
    }

    if (this.opts.staticRootPath) {
      this.server.register(require('@fastify/static'), {
        root: this.opts.staticRootPath,
        prefix: this.opts.staticPrefix,
        constraints: this.opts.staticConstraints
      })

      if (this.opts.staticOn404File) {
        this.server.setNotFoundHandler((_, reply) => {
          return reply.code(404).type('text/html').sendFile(this.opts.staticOn404File)
        })
      }
    }

    this.mem.plugins.forEach(p => {
      this.server.register(p[0], p[1])
    })

    this.mem.decorators.forEach(d => {
      this.server.decorate(d[0], d[1], d[2])
    })

    // Register hooks
    this.mem.hooks.forEach(hook => {
      this.server.addHook(hook.name, hook.handler)
    })

    if (this.opts.addDefaultRoutes) {
      DEFAULT_ROUTES.forEach(r => {
        this.server.route(r)
      })
    }

    this.server.register(async () => {
      this.mem.routes.forEach(r => {
        this.server.route(r)
      })
    })

    return await this.server.listen({
      port: this.opts.port || this.conf.port
    })
  }

  _stop (cb) {
    async.series([
      next => { super._stop(next) },
      async () => {
        if (this.server) {
          await this.server.close()
        }
      }
    ], cb)
  }
}

module.exports = HttpdFacility
