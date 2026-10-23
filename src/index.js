import { createRequire } from 'node:module';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

const require = createRequire(import.meta.url);
const { createService, toolsFor, makeRoute } = require('../lib/server.cjs');
const { registerBindingTools } = require('../lib/binding-tools.cjs');
const { remoteToolGuard } = require('../lib/remote-guard.cjs');

export const name = 'dsh-remote-workspace';
export const inject = ['tools'];
export const Config = Schema.object({
  localRoot: Schema.string().default(''),
  dataDir: Schema.string().default(''),
});

// defineTool handles the property DSL -> model-facing JSON Schema conversion.
// Never pass a raw JSON Schema field map directly to ctx.tools.register.
export function officialToolDefinitions(service) {
  return toolsFor(service).map(tool => {
    const mandatory = new Set(tool.parameters.required || []);
    const parameters = Object.fromEntries(
      Object.entries(tool.parameters.properties).map(([key, def]) => [key, {
        ...def,
        ...(mandatory.has(key) ? { required: true } : {}),
      }]),
    );
    return defineTool({
      name: tool.name,
      description: tool.description,
      parameters,
      output: tool.output,
      execute: tool.execute,
    });
  });
}

export function apply(ctx, config = {}) {
  const profileDir = ctx.get?.('profileContext')?.dir || '';
  const service = createService(config, { profileDir });
  service.questions = ctx.get?.('userQuestions') || null;
  if (typeof ctx.on === 'function') ctx.on('tools/pre-execute', (exec,next) => remoteToolGuard(service,exec,next));
  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['userQuestions'], scopedCtx => { service.questions = scopedCtx.userQuestions; }); }
    catch (e) { console.warn('[remote-workspace] optional approval channel unavailable:', e?.message || e); }
  }
  // This effect belongs only to this plugin fiber. Reloading it must not stop
  // Harness, unrelated plugins, or persistent workspace/credential data.
  if (typeof ctx.effect === 'function') ctx.effect(() => () => service.dispose());
  for (const tool of officialToolDefinitions(service)) ctx.tools.register(tool);
  // Optional, session-scoped local workspace tool support. Never require these
  // services for Host activation: Desktop profiles can omit them.
  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['workingDirectory'], scopedCtx => {
      try { service.workingDirectory = scopedCtx.workingDirectory; registerBindingTools({tools:ctx.tools, workingDirectory:scopedCtx.workingDirectory},service,defineTool); }
      catch (e) { console.warn('[remote-workspace] binding tools unavailable:',e?.message||e); }
    }); } catch (e) { console.warn('[remote-workspace] optional workingDirectory failed:',e?.message||e); }
    try { ctx.inject(['sessionTitle'], scopedCtx => {
      service.sessionTitle = scopedCtx.sessionTitle;
      if (typeof scopedCtx.effect === 'function') scopedCtx.effect(() => () => { service.sessionTitle = null; });
    }); } catch(e) { console.warn('[remote-workspace] optional sessionTitle unavailable:',e?.message||e); }
    try { ctx.inject(['workspaceRegistry'], scopedCtx => {
      try { service.bindingRegistry = scopedCtx.workspaceRegistry;
        service.native.setRegistry(scopedCtx.workspaceRegistry);
        service.virtual.setRegistry(scopedCtx.workspaceRegistry); }
      catch (e) { console.warn('[remote-workspace] workspace registry unavailable:',e?.message||e); }
      if (typeof scopedCtx.effect === 'function') scopedCtx.effect(() => () => { service.bindingRegistry = null; service.native.setRegistry(null); service.virtual.setRegistry(null); });
    }); } catch(e) { console.warn('[remote-workspace] optional workspaceRegistry failed:',e?.message||e); }
  }

  // Connection is optional in CLI/agent-only profiles; no standalone HTTP listener.
  // Desktop's Electron carrier and Web share this authenticated /api route registry.
  // Optional Host management route. It must never make the main application
  // unbootable when the Desktop carrier differs from published Web docs.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['connection'], connectionCtx => {
        try {
          const connection = connectionCtx.connection;
          if (!connection?.fetch?.register) {
            console.warn('[remote-workspace] connection.fetch unavailable; UI API disabled');
            return;
          }
          if (typeof connectionCtx.effect !== 'function') {
            console.warn('[remote-workspace] connection context has no effect(); UI API disabled');
            return;
          }
          return connectionCtx.effect(
            () => {
              try { return connection.fetch.register(makeRoute(service)); }
              catch (error) {
                console.warn('[remote-workspace] optional route effect failed:', error?.message || error);
                return () => {};
              }
            },
            'remote-workspace authenticated file management API',
          );
        } catch (error) {
          console.warn('[remote-workspace] optional UI API registration failed:', error?.message || error);
        }
      });
    } catch (error) {
      console.warn('[remote-workspace] optional connection injection failed:', error?.message || error);
    }
  }
}
