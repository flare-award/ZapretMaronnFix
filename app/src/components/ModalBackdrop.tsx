import React, { useEffect, useRef } from 'react';

interface ModalBackdropProps {
  onClose?: () => void;
  children: React.ReactNode;
}

export const ModalBackdrop: React.FC<ModalBackdropProps> = ({ onClose, children }) => {
  const pressedOnBackdropRef = useRef(false);

  useEffect(() => {
    if (!onClose) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    pressedOnBackdropRef.current = e.target === e.currentTarget && e.button === 0;
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onClose) return;
    const releasedOnBackdrop = e.target === e.currentTarget && e.button === 0;
    const shouldClose = pressedOnBackdropRef.current && releasedOnBackdrop;
    pressedOnBackdropRef.current = false;
    if (shouldClose) {
      onClose();
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {children}
    </div>
  );
};
