import { defineConfig } from 'tsdown'

export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [{
  entry: { client: 'lib/types/client/index.js' }, outDir: 'lib', platform: 'browser',
  format: ['esm'], target: 'es2022', fixedExtension: false, dts: false, clean: false,
  deps: { alwaysBundle: [/.*/] },
}] : {
  entry: ['lib/types/index.js', 'lib/types/default-agent.js'], outDir: 'lib', platform: 'node',
  format: ['esm'], target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
