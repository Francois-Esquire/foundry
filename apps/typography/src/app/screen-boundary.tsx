import { Component, type ReactNode } from "react";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";

interface ScreenBoundaryProps {
  readonly children: ReactNode;
  readonly name: string;
}

const reload = () => window.location.reload();

/**
 * Keeps a failing screen from taking the shell down with it. The project
 * lives in the workspace above, so the screen can be mounted again without
 * losing it. Reloading the page is the last resort, because it empties the
 * project. React only offers this to class components.
 */
export class ScreenBoundary extends Component<ScreenBoundaryProps> {
  static getDerivedStateFromError() {
    return { failed: true };
  }

  state: { readonly failed: boolean } = { failed: false };

  /** Mounts the screen afresh. Everything below the boundary was taken down when it failed. */
  readonly retry = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? (
      <Notice
        action={
          <>
            <Button onClick={this.retry} variant="solid">
              Try this place again
            </Button>
            <Button onClick={reload}>Reload and empty the project</Button>
          </>
        }
        tone="problem"
      >
        {this.props.name} stopped working. The project is still open, with every
        font and change in it. Try this place again, or open another place and
        come back. Reloading the page empties the project.
      </Notice>
    ) : (
      this.props.children
    );
  }
}
