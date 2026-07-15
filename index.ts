// gesture-handler 必须在任何其他导入之前引入（原生端要求）。
import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';

// TaskManager definitions must execute in bundle global scope so Android can
// start the worker without mounting React views.
import './src/services/generationTaskBackground';
import { installGenerationTaskNotificationHandler } from './src/services/generationTaskNotifications';
import App from './App';

installGenerationTaskNotificationHandler();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
