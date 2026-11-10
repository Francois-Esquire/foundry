const STORAGE = "https://rest.fal.ai/";
const PLACE = "https://put.example/reference.png";

/**
 * Puts a stand-in for fal's storage in front of a test's own stand-in for a
 * model. A vector model call is preceded by an upload of its reference: the
 * storage gives a place and the place takes the picture. Every other request
 * goes on to the model stand-in, which therefore still sees one call a run.
 */
export const withFalStorage =
  (model: typeof fetch): typeof fetch =>
  (input, init) => {
    const address = String(input);
    if (address.startsWith(STORAGE)) {
      return Promise.resolve(
        Response.json({
          file_url: "https://storage.example/reference.png",
          upload_url: PLACE,
        })
      );
    }
    if (address === PLACE) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    return model(input, init);
  };
