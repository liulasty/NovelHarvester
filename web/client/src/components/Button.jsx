export default function Button({ variant = 'default', className = '', type = 'button', ...rest }) {
  const extra =
    variant === 'primary'
      ? 'btn-primary'
      : variant === 'run'
        ? 'btn-run'
        : variant === 'danger'
          ? 'btn-danger'
          : variant === 'save'
            ? 'btn-save'
            : '';
  return <button type={type} className={['btn', extra, className].filter(Boolean).join(' ')} {...rest} />;
}
