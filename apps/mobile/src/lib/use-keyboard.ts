import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Whether the software keyboard is open. While it is, the bottom safe-area
 * inset (home indicator / navigation bar) is covered by the keyboard, so
 * bottom-pinned bars should not add it again.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => {
        setVisible(true);
      },
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setVisible(false);
      },
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}
