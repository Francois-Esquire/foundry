import React from "react";
import { render } from "ink";

import { App } from "./App";

if (import.meta.main) {
  render(<App />);
}

export default App;
