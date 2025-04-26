// offlineEmbed.ts
import * as tf from '@tensorflow/tfjs-node'; // TensorFlow runtime
import * as use from '@tensorflow-models/universal-sentence-encoder';

let model: use.UniversalSentenceEncoder;

export async function load() {
  model ??= await use.load();
  return model;
}

export async function embed(texts: string[]) {
  // 1) Load the USE model from local cache (it will download once)
  await load();

  // 2) Prepare your texts
  // const texts = [
  //   "import fs from 'fs';",
  //   'function chunkByLines(text) { /* … */ }',
  //   'async function embed(text) { /* … */ }',
  // ];

  // 3) Embed!
  const embeddings: tf.Tensor2D = await model.embed(texts);

  // 4) Convert to plain JavaScript arrays
  const arrayEmbeddings = await embeddings.array();

  // 5) Clean up
  tf.dispose(embeddings);

  return arrayEmbeddings;
}
