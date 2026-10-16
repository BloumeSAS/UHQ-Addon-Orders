import { Module } from '@nestjs/common';
import { StoreService } from './store.service';
import { PanelAuthService } from './panel-auth.service';
import { WalletClient } from './wallet.client';
import { PanelClient } from './panel.client';
import { PaymentsService } from './payments/payments.service';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';

@Module({
  providers: [StoreService, PanelAuthService, WalletClient, PanelClient, PaymentsService, OrdersService],
  controllers: [OrdersController],
  exports: [StoreService, PanelAuthService],
})
export class OrdersModule {}
