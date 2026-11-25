import { useId, type ComponentPropsWithoutRef, type Ref } from 'react';

type Props = ComponentPropsWithoutRef<'button'> & { hint: string; buttonRef?: Ref<HTMLButtonElement> };

export function TitleBarButton({ hint, buttonRef, children, ...button }: Props) {
  const id = useId();
  return <span className="titlebar-control">
    <button type="button" {...button} ref={buttonRef} aria-describedby={id}>{children}</button>
    <span className="titlebar-hint" id={id} role="tooltip">{hint}</span>
  </span>;
}
