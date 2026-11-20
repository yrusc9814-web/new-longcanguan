import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');

const read = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');
const size = (relativePath: string) => statSync(resolve(root, relativePath)).size;

const AUDIO_ASSETS = [
  'assets/audio/timer_alarm.m4a',
  'assets/audio/wheel_exclude.m4a',
  'assets/audio/wheel_winner.m4a',
] as const;

const copiedAssets = [
  'index.html',
  'public/google2-adapter.js',
  'public/assets/tailwind/tailwindcss-3.4.17.browser.min.js',
  ...AUDIO_ASSETS.map((path) => `public/${path}`),
  'resources/brand-logo.png',
  'resources/home-hero.png',
] as const;

describe('离线资产迁移完整性', () => {
  it('生产页面与适配器、脚本、音频、品牌图全部落盘', () => {
    for (const asset of copiedAssets) {
      expect(existsSync(resolve(root, asset)), asset).toBe(true);
      expect(size(asset), asset).toBeGreaterThan(0);
    }
  });

  it('index.html 保留生产标题与本地脚本入口', () => {
    const html = read('index.html');
    expect(html).toContain('<title>搭饭小馆</title>');
    expect(html).toContain('src="/assets/tailwind/tailwindcss-3.4.17.browser.min.js"');
    expect(html).toContain('<script type="module" src="/src/local-api/bootstrap.ts"></script>');
    expect(html).toContain('src="/google2-adapter.js"');
    expect(html).toContain('id="appViewport"');
  });

  it('index.html 引用的每个本地资源都能解析到磁盘文件', () => {
    const html = read('index.html');
    const references = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const relative = reference.startsWith('/src/') ? reference.slice(1) : `public${reference}`;
      expect(existsSync(resolve(root, relative)), relative).toBe(true);
    }
  });

  it('音频引用使用相对路径，Capacitor 内 WebView 可直接加载', () => {
    const html = read('index.html');
    for (const asset of AUDIO_ASSETS) {
      expect(html).toContain(`new Audio('${asset}')`);
      expect(existsSync(resolve(root, 'public', asset)), asset).toBe(true);
    }
  });

  it('页面不依赖任何外部网络资源（SVG 命名空间除外）', () => {
    for (const file of ['index.html', 'public/google2-adapter.js']) {
      const text = read(file);
      const urls = [...text.matchAll(/https?:\/\/[^\s"'`)<>]+/g)]
        .map((match) => match[0])
        .filter((url) => !url.startsWith('http://www.w3.org/'));
      expect(urls, file).toEqual([]);
    }
  });

  it('适配器保持生产脚本契约（API 基址与 PIN 存储键）', () => {
    const adapter = read('public/google2-adapter.js');
    expect(adapter).toContain("const API_BASE = '/api/v1'");
    expect(adapter).toContain("const PIN_KEY = 'dafan_google2_pin_token'");
    expect(adapter).toContain('window.DafanDomainAdapter');
  });
});

describe('Vite 构建产物', () => {
  it('dist 内保留 index.html、适配器、Tailwind 与三份音频', () => {
    const expected = [
      'index.html',
      'google2-adapter.js',
      'assets/tailwind/tailwindcss-3.4.17.browser.min.js',
      ...AUDIO_ASSETS,
    ];
    for (const asset of expected) {
      expect(existsSync(resolve(dist, asset)), asset).toBe(true);
    }
  });

  it('Vite 只重写端内启动入口，保留页面 DOM、样式与内联脚本', () => {
    const source = read('index.html');
    const built = read('dist/index.html');
    const sourceEntry =
      /^ *<script type="module" src="\/src\/local-api\/bootstrap\.ts"><\/script>\r?\n/m;
    const builtEntry =
      /^ *<script type="module"[^>]* src="(\/assets\/[^"/]+\.js)"><\/script>\r?\n/m;
    const output = built.match(builtEntry)?.[1];
    expect(output).toBeDefined();
    expect(existsSync(resolve(dist, `.${output}`))).toBe(true);
    expect(built.replace(builtEntry, '')).toBe(source.replace(sourceEntry, ''));
  });

  it('dist 内联脚本与源文件字节一致', () => {
    const source = readFileSync(resolve(root, 'public/google2-adapter.js'));
    const built = readFileSync(resolve(dist, 'google2-adapter.js'));
    expect(built.equals(source)).toBe(true);
  });
});

describe('Capacitor Android 外壳约束', () => {
  it('capacitor.config.ts 固定 appId / appName / webDir', () => {
    const config = read('capacitor.config.ts');
    expect(config).toContain("appId: 'com.dafan.xiaoguan'");
    expect(config).toContain("appName: '搭饭小馆'");
    expect(config).toContain("webDir: 'dist'");
  });

  it('AndroidManifest 关闭备份并锁定竖屏', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:fullBackupContent="false"');
    expect(manifest).toContain('android:screenOrientation="portrait"');
    expect(manifest).toContain('android:label="@string/app_name"');
  });

  it('MainActivity 位于 Capacitor appId 对应的包中', () => {
    const activity = read('android/app/src/main/java/com/dafan/xiaoguan/MainActivity.java');
    expect(activity).toContain('package com.dafan.xiaoguan;');
  });

  it('生成的应用名与包名写回 strings.xml', () => {
    const strings = read('android/app/src/main/res/values/strings.xml');
    expect(strings).toContain('<string name="app_name">搭饭小馆</string>');
    expect(strings).toContain('<string name="package_name">com.dafan.xiaoguan</string>');
  });

  it('Windows 中文路径可以通过 AGP 的项目路径检查', () => {
    const gradleProperties = read('android/gradle.properties');
    expect(gradleProperties).toContain('android.overridePathCheck=true');
  });
});
