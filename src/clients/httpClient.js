import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

function makeFetchResponse(res, bodyBuffer) {
  return {
    status: res.statusCode ?? 0,
    ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
    headers: {
      get(name) {
        return res.headers[name.toLowerCase()] ?? null;
      },
    },
    text: async () => bodyBuffer.toString('utf-8'),
    json: async () => {
      const text = bodyBuffer.toString('utf-8');
      return text ? JSON.parse(text) : null;
    },
  };
}

export async function nodeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = url instanceof URL ? url : new URL(url);
    const { method = 'GET', headers = {}, body } = options;
    const requestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    };
    const transport = target.protocol === 'http:' ? http : https;
    const req = transport.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(makeFetchResponse(res, buffer));
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}
