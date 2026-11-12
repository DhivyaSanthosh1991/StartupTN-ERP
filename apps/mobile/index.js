import { registerRootComponent } from 'expo';
import './src/tracking'; // must load first: it registers the background task
import App from './src/App';

registerRootComponent(App);
