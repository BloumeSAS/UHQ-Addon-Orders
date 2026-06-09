import { Routes, Route } from 'react-router-dom';
import { AddonProvider } from './context';
import Store         from './pages/Store';
import AdminOrders   from './pages/AdminOrders';
import OrdersWidget  from './widgets/OrdersWidget';

/**
 * Routes :
 *   /                  → boutique utilisateur (catalogue + mes commandes)
 *   /admin             → gestion admin (produits CRUD + toutes les commandes)
 *   /widget/dashboard  → widget compact (AddonPageBar sur le Dashboard)
 */
export default function App() {
  return (
    <AddonProvider>
      <Routes>
        <Route path="/"                 element={<Store />} />
        <Route path="/admin"            element={<AdminOrders />} />
        <Route path="/widget/dashboard" element={<OrdersWidget />} />
      </Routes>
    </AddonProvider>
  );
}
