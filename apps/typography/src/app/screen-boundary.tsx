import { Component, type ReactNode } from "react";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";

interface ScreenBoundaryProps {
  readonly children: ReactNode;
  readonly name: string;
}

const reload = () => window.location.reload();

/**
 * Keeps a failing screen from taking the shell down with it. React only
 * offers this to class components.
 */
export class ScreenBoundary extends Component<ScreenBoundaryProps> {
  static getDerivedStateFromError() {
    return { failed: true };
  }

  state: { readonly failed: boolean } = { failed: false };

  render() {
    return this.state.failed ? (
      <Notice action={<Button onClick={reload}>Reload</Button>} tone="problem">
        {this.props.name} stopped working. Reload the page to open it again.
      </Notice>
    ) : (
      this.props.children
    );
  }
}
