import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonicalPageUrl, isDiscoverablePage, localRoute, rewriteInternalHref, isTransactionalLink } from './routes.js';
import { generateAstro } from './generator.js';
import { transformSiteFolder } from './transformer.js';

test('normalizes routes and disallows transactional crawl paths', () => {
  assert.equal(canonicalPageUrl('https://example.com/contact?x=1#top'), 'https://example.com/contact/');
  assert.equal(localRoute('https://shop.example.org/products/', 'https://example.com'), '/external-shop.example.org/products/');
  const origins = new Set(['https://example.com']);
  assert.equal(isDiscoverablePage('/checkout/', 'https://example.com', origins), false);
  assert.equal(isDiscoverablePage('/contact/', 'https://example.com', origins), true);
  assert.equal(isDiscoverablePage('https://other.com/', 'https://example.com', origins), false);
  const routes = new Map([['https://example.com/shop/', '/shop/']]);
  assert.equal(rewriteInternalHref('https://example.com/shop/#products', 'https://example.com/', routes), '/shop/#products');
  assert.equal(isTransactionalLink('/?add-to-cart=42'), true);
});

test('generates local links, shares exact headers, and disables checkout', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-astro-'));
  try {
    const source = path.join(temp, 'source');
    const target = path.join(temp, 'generated');
    const snap = { box: { x:0, y:0, width:500, height:100 }, styles: { visibility:'visible', opacity:'1' }, visible:true };
    const node = (id: number, tag: string, attributes: Record<string, string>, text = '', children: unknown[] = []) =>
      ({ id, tag, attributes, text, desktop:snap, children });
    const header = (id: number) => ({ kind:'header', label:'header', root:node(id, 'header', {class:'site-header'}, '', [node(id + 1, 'a', {href:'https://example.com/shop/'}, 'Shop')]) });
    const footer = (id: number) => ({ kind:'footer', label:'footer', root:node(id, 'footer', {}, 'Footer') });
    const pages = [
      { route:'/', folder:'pages/000', sourceUrl:'https://example.com/', finalUrl:'https://example.com/' },
      { route:'/shop/', folder:'pages/001', sourceUrl:'https://example.com/shop/', finalUrl:'https://example.com/shop/' },
    ];
    await fs.mkdir(source, {recursive:true});
    await fs.writeFile(path.join(source, 'site-manifest.json'), JSON.stringify({schemaVersion:1, sourceUrl:'https://example.com/', pages}));
    for (const [index, page] of pages.entries()) {
      const folder = path.join(source, page.folder);
      await fs.mkdir(folder, {recursive:true});
      const ir = {schemaVersion:1, sourceUrl:page.sourceUrl, metadata:{title:index?'Shop':'Home',description:'',language:'en'},
        modularization:{policy:{mode:'strict-hybrid', minimumOccurrences:3,autoApprove:false}, candidates:[]},
        assets:[], theme:{bodyClass:'site',css:'.site { color: red }'}, sections:[
          header(index * 20 + 1),
          {kind:'content', label:'body', root:node(index * 20 + 3, 'section', {}, '', [
            node(index * 20 + 4, 'a', {href:index?'/checkout/':'https://example.com/shop/'}, index?'Checkout':'Online Shop'),
            node(index * 20 + 5, 'button', {type:'submit'}, 'Buy now'),
            node(index * 20 + 6, 'a', {href:'/uncaptured/'}, 'Uncaptured'),
          ])}, footer(index * 20 + 10),
        ]};
      await fs.writeFile(path.join(folder,'page-ir.json'), JSON.stringify(ir));
    }
    const result = await generateAstro(source, target);
    assert.equal(result.sections, 6);
    const home = await fs.readFile(path.join(target,'src/pages/index.astro'),'utf8');
    const shop = await fs.readFile(path.join(target,'src/pages/shop/index.astro'),'utf8');
    assert.match(home, /href="\/shop\/"/);
    assert.match(shop, /data-static-action="true"/);
    assert.doesNotMatch(shop, /href="\/checkout\/"/);
    assert.match(shop, /data-static-submit="true"/);
    assert.doesNotMatch(shop, /href="\/uncaptured\/"/);
    const components = (await fs.readdir(path.join(target,'src/components'))).filter(n => n.endsWith('.astro'));
    assert.equal(components.filter(n => n.startsWith('Header_')).length, 1);
    assert.equal(components.filter(n => n.startsWith('Footer_')).length, 1);
    assert.match(shop, /import Header from "\.\.\/\.\.\/components\//);
  } finally { await fs.rm(temp, {recursive:true,force:true}); }
});

test('site transformer emits one IR per page using captured fixtures', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-transform-'));
  try {
    await fs.mkdir(path.join(tmp, 'pages/000'), {recursive:true});
    await fs.writeFile(path.join(tmp, 'site-manifest.json'), JSON.stringify({schemaVersion:1, pages:[{folder:'pages/000'}]}));
    const capture = {url:'https://example.com/',title:'Home',description:'',language:'en',
      viewport:{width:1440,height:900,documentWidth:1440,documentHeight:900}, totalElementCount:2,extractedElementCount:2,
      elements:[{id:0,parentIndex:-1,tag:'html',attributes:{},text:'',rectangle:{x:0,y:0,width:1440,height:900},computedStyles:{}},
        {id:1,parentIndex:0,tag:'body',attributes:{},text:'',rectangle:{x:0,y:0,width:1440,height:900},computedStyles:{}}],
      images:[],headings:[],links:[],fonts:[]};
    await fs.writeFile(path.join(tmp,'pages/000/desktop-data.json'), JSON.stringify(capture));
    const result = await transformSiteFolder(tmp);
    assert.equal(result.pages, 1);
    await fs.access(path.join(tmp,'pages/000/page-ir.json'));
  } finally { await fs.rm(tmp,{recursive:true,force:true}); }
});
