// offlineEmbed.ts
import * as use from "@tensorflow-models/universal-sentence-encoder";
import * as tf from "@tensorflow/tfjs-node"; // TensorFlow runtime

let model: use.UniversalSentenceEncoder;

export async function load() {
  model ??= await use.load();
  return model;
}

export async function embed(texts: string[]) {
  await load();

  const embeddings: tf.Tensor2D = await model.embed(texts);

  const arrayEmbeddings = await embeddings.array();

  tf.dispose(embeddings);

  return arrayEmbeddings;
}
