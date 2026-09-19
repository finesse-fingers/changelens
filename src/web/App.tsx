import { useState } from 'react';
import { TargetPicker } from './components/TargetPicker.js';
import { ReviewConsole } from './components/ReviewConsole.js';
import { useReview } from './store/review.js';

export function App() {
  const data = useReview((s) => s.data);
  const [picking, setPicking] = useState(true);

  if (picking || !data) {
    return <TargetPicker onLoaded={() => setPicking(false)} />;
  }
  return <ReviewConsole onChangeTarget={() => setPicking(true)} />;
}
