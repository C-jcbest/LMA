import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

vi.mock('@radix-ui/react-popover', async () => {
  const React = await import('react');
  const Context = React.createContext<{ open: boolean; setOpen: (v: boolean) => void }>({
    open: false,
    setOpen: () => {},
  });

  const Root = ({ children, open: controlledOpen, onOpenChange, defaultOpen = false }: any) => {
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : uncontrolledOpen;
    const setOpen = (v: boolean) => {
      if (!isControlled) setUncontrolledOpen(v);
      onOpenChange?.(v);
    };
    return React.createElement(Context.Provider, { value: { open, setOpen } }, children);
  };

  const Trigger = React.forwardRef(({ children, asChild, onClick, ...props }: any, ref: any) => {
    const { open, setOpen } = React.useContext(Context);
    const handleClick = (e: any) => {
      onClick?.(e);
      setOpen(!open);
    };
    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children as any, {
        ref,
        onClick: (e: any) => {
          (children.props as any)?.onClick?.(e);
          handleClick(e);
        },
        'aria-expanded': open,
        'data-state': open ? 'open' : 'closed',
        ...props,
      });
    }
    return React.createElement(
      'button',
      { ref, onClick: handleClick, 'aria-expanded': open, 'data-state': open ? 'open' : 'closed', ...props },
      children
    );
  });

  const Portal = ({ children }: any) => React.createElement(React.Fragment, null, children);

  const Content = React.forwardRef(({ children, ...props }: any, ref: any) => {
    const { open } = React.useContext(Context);
    if (!open) return null;
    return React.createElement('div', { ref, role: 'dialog', 'data-state': 'open', ...props }, children);
  });

  return {
    Root,
    Trigger,
    Portal,
    Content,
    Anchor: ({ children }: any) => React.createElement(React.Fragment, null, children),
    Arrow: () => null,
    Close: ({ children, onClick, ...props }: any) => {
      const { setOpen } = React.useContext(Context);
      return React.createElement(
        'button',
        { onClick: (e: any) => { onClick?.(e); setOpen(false); }, ...props },
        children
      );
    },
  };
});

vi.mock('@radix-ui/react-dropdown-menu', async () => {
  const React = await import('react');
  const Context = React.createContext<{ open: boolean; setOpen: (v: boolean) => void }>({
    open: false,
    setOpen: () => {},
  });

  const Root = ({ children, open: controlledOpen, onOpenChange, defaultOpen = false }: any) => {
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : uncontrolledOpen;
    const setOpen = (v: boolean) => {
      if (!isControlled) setUncontrolledOpen(v);
      onOpenChange?.(v);
    };
    return React.createElement(Context.Provider, { value: { open, setOpen } }, children);
  };

  const Trigger = React.forwardRef(({ children, asChild, onClick, ...props }: any, ref: any) => {
    const { open, setOpen } = React.useContext(Context);
    const handleClick = (e: any) => {
      onClick?.(e);
      setOpen(!open);
    };
    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children as any, {
        ref,
        onClick: (e: any) => {
          (children.props as any)?.onClick?.(e);
          handleClick(e);
        },
        'aria-expanded': open,
        'data-state': open ? 'open' : 'closed',
        ...props,
      });
    }
    return React.createElement(
      'button',
      { ref, onClick: handleClick, 'aria-expanded': open, 'data-state': open ? 'open' : 'closed', ...props },
      children
    );
  });

  const Portal = ({ children }: any) => React.createElement(React.Fragment, null, children);

  const Content = React.forwardRef(({ children, side, align, sideOffset, alignOffset, ...props }: any, ref: any) => {
    const { open } = React.useContext(Context);
    if (!open) return null;
    return React.createElement('div', { ref, role: 'menu', 'data-state': 'open', ...props }, children);
  });

  const Item = React.forwardRef(({ children, onClick, ...props }: any, ref: any) => {
    const { setOpen } = React.useContext(Context);
    const handleClick = (e: any) => {
      onClick?.(e);
      setOpen(false);
    };
    return React.createElement(
      'div',
      { ref, role: 'menuitem', tabIndex: -1, onClick: handleClick, ...props },
      children
    );
  });

  return {
    Root,
    Trigger,
    Portal,
    Content,
    Item,
    Group: ({ children }: any) => React.createElement(React.Fragment, null, children),
    Separator: () => null,
    Sub: ({ children }: any) => React.createElement(React.Fragment, null, children),
    SubTrigger: React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement('div', { ref, ...props }, children)
    ),
    SubContent: React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement('div', { ref, ...props }, children)
    ),
    RadioGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
    RadioItem: React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement('div', { ref, role: 'menuitemradio', ...props }, children)
    ),
    CheckboxItem: React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement('div', { ref, role: 'menuitemcheckbox', ...props }, children)
    ),
    Label: React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement('div', { ref, ...props }, children)
    ),
    ItemIndicator: () => null,
  };
});

vi.mock('@assistant-ui/react', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<any>();
  return {
    ...actual,
    ThreadPrimitive: {
      ...actual.ThreadPrimitive,
      If: ({ children, running }: any) => {
        // running: false renders children when idle; running: true renders children when running
        return running ? null : React.createElement(React.Fragment, null, children);
      },
      Suggestion: ({ children, asChild, autoSend, prompt, method, ...props }: any) => {
        if (asChild && React.isValidElement(children)) {
          return React.cloneElement(children as any, props);
        }
        return React.createElement('div', props, children);
      },
    },
    ComposerPrimitive: {
      ...actual.ComposerPrimitive,
      Root: ({ children, ...props }: any) => React.createElement('div', props, children),
      Input: React.forwardRef(({ ...props }: any, ref: any) =>
        React.createElement('textarea', { ref, ...props })
      ),
      Send: ({ children, asChild, ...props }: any) => {
        if (asChild && React.isValidElement(children)) {
          return React.cloneElement(children as any, props);
        }
        return React.createElement('button', props, children);
      },
      Cancel: ({ children, asChild, ...props }: any) => {
        if (asChild && React.isValidElement(children)) {
          return React.cloneElement(children as any, props);
        }
        return React.createElement('button', props, children);
      },
    },
  };
});

afterEach(cleanup);

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined,
});

if (typeof window !== 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = window.ResizeObserver || ResizeObserverMock;



  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture || (() => {});
}
