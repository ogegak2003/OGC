import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { App } from './App';

describe('App', () => {
  it('renders the OGC brand and an example identity', async () => {
    await render(<App />);
    expect(screen.getByRole('header')).toHaveTextContent('OGC');
    expect(screen.getByText('ObagaGlobal Communication')).toBeOnTheScreen();
    expect(screen.getByText('OGC000001')).toBeOnTheScreen();
  });
});
