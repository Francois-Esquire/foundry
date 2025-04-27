import React from "react";
import { render } from "ink";

import { App } from "./app";

if (import.meta.main) {
  render(<App />);
}

export default App;
