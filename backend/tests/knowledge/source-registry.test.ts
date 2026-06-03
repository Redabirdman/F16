/**
 * Knowledge source registry — unit tests (M7.T3).
 *
 * Pure in-memory map + adapter resolution; no infra needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerKnowledgeSource,
  getKnowledgeSource,
  listKnowledgeSources,
  __resetKnowledgeSourcesForTests,
  adapterFor,
} from '../../src/knowledge/source-registry.js';
import {
  bootstrapKnowledgeSources,
  __resetBootstrapForTests,
} from '../../src/knowledge/bootstrap.js';
import { markdownFileAdapter } from '../../src/knowledge/adapters/markdown-file.js';
import { reactSourceAdapter } from '../../src/knowledge/adapters/react-source.js';

describe('source-registry', () => {
  beforeEach(() => {
    __resetKnowledgeSourcesForTests();
    __resetBootstrapForTests();
  });

  it('test 1: register + get round-trips', () => {
    registerKnowledgeSource({
      name: 'fx-md',
      adapter: 'markdown-file',
      path: '/tmp/foo.md',
    });
    const cfg = getKnowledgeSource('fx-md');
    expect(cfg).toBeDefined();
    expect(cfg!.name).toBe('fx-md');
    expect(cfg!.adapter).toBe('markdown-file');
    expect(cfg!.path).toBe('/tmp/foo.md');
  });

  it('test 2: duplicate name throws', () => {
    registerKnowledgeSource({
      name: 'dupe',
      adapter: 'markdown-file',
      path: '/tmp/a.md',
    });
    expect(() =>
      registerKnowledgeSource({
        name: 'dupe',
        adapter: 'markdown-file',
        path: '/tmp/b.md',
      }),
    ).toThrow(/already registered/);
  });

  it('test 3: list returns every registered source', () => {
    registerKnowledgeSource({ name: 'a', adapter: 'markdown-file', path: '/a' });
    registerKnowledgeSource({ name: 'b', adapter: 'react-source', path: '/b' });
    registerKnowledgeSource({ name: 'c', adapter: 'markdown-file', path: '/c' });
    const names = listKnowledgeSources()
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('test 4: __resetKnowledgeSourcesForTests clears the registry', () => {
    registerKnowledgeSource({ name: 'a', adapter: 'markdown-file', path: '/a' });
    expect(listKnowledgeSources()).toHaveLength(1);
    __resetKnowledgeSourcesForTests();
    expect(listKnowledgeSources()).toHaveLength(0);
    expect(getKnowledgeSource('a')).toBeUndefined();
  });

  it('test 5: adapterFor("markdown-file") returns the markdown adapter singleton', () => {
    const a = adapterFor('markdown-file');
    expect(a).toBe(markdownFileAdapter);
    expect(a.id).toBe('markdown-file');
  });

  it('test 6: adapterFor("react-source") returns the react-source adapter singleton', () => {
    const a = adapterFor('react-source');
    expect(a).toBe(reactSourceAdapter);
    expect(a.id).toBe('react-source');
  });

  it('test 7: bootstrap registers all known sources, idempotent on second call', () => {
    bootstrapKnowledgeSources();
    const names1 = listKnowledgeSources()
      .map((s) => s.name)
      .sort();
    expect(names1).toContain('assuryal_knowledge_md');
    expect(names1).toContain('assuryal_website_source');
    expect(names1).toContain('maxance_product_catalog');
    expect(names1).toHaveLength(3);

    // Second call must NOT throw (despite duplicate-name guard inside register)
    // because the once-flag short-circuits.
    expect(() => bootstrapKnowledgeSources()).not.toThrow();
    expect(listKnowledgeSources()).toHaveLength(3);

    const md = getKnowledgeSource('assuryal_knowledge_md');
    expect(md?.adapter).toBe('markdown-file');
    expect(md?.intervalHours).toBe(24);
    const site = getKnowledgeSource('assuryal_website_source');
    expect(site?.adapter).toBe('react-source');
    expect(site?.intervalHours).toBe(6);

    // M9 — Maxance product catalogue, ingested via the markdown adapter.
    const catalog = getKnowledgeSource('maxance_product_catalog');
    expect(catalog?.adapter).toBe('markdown-file');
    expect(catalog?.intervalHours).toBe(24);
    expect(catalog?.scheduled).toBe(true);
  });
});
