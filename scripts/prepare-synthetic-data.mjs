import { copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const data = new URL('../data/', import.meta.url);
for (const name of ['commanders', 'native-loadouts', 'native_battle_maps']) {
  const target = new URL(`${name}.json`, data);
  try {
    await copyFile(new URL(`${name}.example.json`, data), target, constants.COPYFILE_EXCL);
    console.log(`created synthetic data/${name}.json`);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    console.log(`kept existing data/${name}.json`);
  }
}
