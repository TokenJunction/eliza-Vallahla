import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['website/swap/client.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'website/swap/swap-bundle.js',
  legalComments: 'none'
});
