import { Module } from '@nestjs/common';
import { StoreService } from './store.service';
import { WalletClient } from './wallet.client';
import { PanelClient } from './panel.client';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';

@Module({
  providers: [StoreService, WalletClient, PanelClient, OrdersService],
  controllers: [OrdersController],
  exports: [StoreService],
})
export class OrdersModule {}
